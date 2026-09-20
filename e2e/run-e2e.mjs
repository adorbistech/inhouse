#!/usr/bin/env node
// Block 13 live E2E driver (TEST-ONLY). Dependency-free; run from the repo root:
//   node e2e/run-e2e.mjs            # seed + test + restart + cleanup
//   node e2e/run-e2e.mjs --keep     # leave disposable data in place
// Everything (control plane and execution) goes through the Inhouse frontend
// proxy (http://127.0.0.1:8091/v1). The only provider is the disposable mock
// container; the only credential is a random b13 test secret generated here.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8091/v1";
const KEEP = process.argv.includes("--keep");
const COMPOSE = ["compose", "-f", "docker-compose.yml", "-f", "e2e/docker-compose.e2e.yml"];
const MOCK_ENDPOINT = "http://inhouse-mock-provider:9000/v1";
const RUN = randomBytes(3).toString("hex");
const P = process.env.E2E_CLEANUP_PREFIX ?? `b13-${RUN}`; // every disposable object name/slug starts with this
const TEST_SECRET = `b13-test-credential-${randomBytes(12).toString("hex")}`;
const secretTag = createHash("sha256").update(TEST_SECRET).digest("hex").slice(0, 12);

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const ADMIN = env.INHOUSE_ADMIN_TOKEN;

// ---------- helpers ----------
const results = [];
const check = (group, name, ok, detail = "") => {
  results.push({ group, name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${group}] ${name}${!ok && detail ? `  -> ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
const psql = (sql) => sh("docker", ["exec", "-i", "inhouse-postgres", "psql", "-U", "inhouse_app", "-d", "inhouse", "-At", "-c", sql]).trim();
const mockLog = () => JSON.parse(sh("docker", ["exec", "inhouse-mock-provider", "wget", "-qO-", "http://127.0.0.1:9000/_mock/log"])).log;
const mockReset = () => sh("docker", ["exec", "inhouse-mock-provider", "wget", "-qO-", "--post-data=", "http://127.0.0.1:9000/_mock/reset"]);
const hits = (model) => mockLog().filter((e) => e.path === "/v1/chat/completions" && e.model === model);

async function api(method, path, body, token = ADMIN, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, json, text };
}
const must = async (method, path, body) => {
  const r = await api(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
};

let CLIENT_KEY = "";
let uniq = 0;
const chat = (workloadId, model, extra = {}, headers = {}) =>
  api("POST", "/chat/completions", { workloadId, model, messages: [{ role: "user", content: `${P}-${++uniq}` }], ...extra }, CLIENT_KEY, headers);
const ledgerAll = async () => (await must("GET", "/usage?limit=500")).usage;
const ledgerFor = async (requestId) => (await ledgerAll()).filter((r) => r.requestId === requestId);
const waitLedger = async (requestId, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const rows = await ledgerFor(requestId);
    if (rows.length > 0 || Date.now() > end) return rows;
    await sleep(150);
  }
};
const rid = () => `${P}-req-${++uniq}`;

async function sse(workloadId, model, { abortAfterFirstChunk = false, extra = {}, requestId = rid(), maxMs = 30_000 } = {}) {
  const ctrl = new AbortController();
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({ workloadId, model, stream: true, messages: [{ role: "user", content: `${P}-${++uniq}` }], ...extra }),
    signal: ctrl.signal,
  });
  const out = { status: res.status, contentType: res.headers.get("content-type"), requestId, frames: [], done: false, bytes: 0, arrivals: [], ms: 0, aborted: false, errorFrame: false, text: "" };
  if (!res.body || res.status !== 200) { out.text = await res.text(); return out; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => ctrl.abort(), maxMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out.bytes += value.length;
      out.arrivals.push(Date.now() - t0);
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (data === "[DONE]") { out.done = true; continue; }
        if (data) { try { const j = JSON.parse(data); out.frames.push(j); if (j.error) out.errorFrame = true; } catch { /* partial */ } }
      }
      if (abortAfterFirstChunk && out.frames.length >= 1) { out.aborted = true; ctrl.abort(); break; }
    }
  } catch (e) { if (!out.aborted) out.aborted = e.name === "AbortError"; }
  clearTimeout(timer);
  out.ms = Date.now() - t0;
  return out;
}
const streamText = (s) => s.frames.map((f) => f.choices?.[0]?.delta?.content ?? "").join("");

// ---------- seed ----------
const ids = { workloads: {}, vendors: {}, models: {}, tiers: {} };
async function seed() {
  console.log(`\n== SEED (run ${P}) ==`);
  for (const w of ["main", "fallback", "fallback-nomatch", "fallback-loop", "cancel", "denied"]) {
    const slug = `${P}-${w}`;
    ids.workloads[w] = psql(`INSERT INTO inhouse.workloads (slug, display_name, description, status) VALUES ('${slug}','${slug}','BLOCK13 E2E DISPOSABLE (${P})','enabled') RETURNING id`).split("\n")[0];
  }
  const mkVendor = async (tag, o) => {
    const v = (await must("POST", "/vendors", {
      slug: `${P}-vendor-${tag}`, displayName: `${P} test vendor ${tag}`, vendorType: "test-mock", protocol: "openai-compatible",
      baseEndpoint: MOCK_ENDPOINT, description: `BLOCK13 E2E DISPOSABLE (${P})`, billingType: "test-only", ...o,
    })).vendor;
    ids.vendors[tag] = v.id;
    await must("PUT", `/vendors/${v.id}/workloads`, { workloadIds: Object.values(ids.workloads) });
    const acct = (await must("POST", `/vendors/${v.id}/accounts`, { slug: `${P}-acct-${tag}`, displayName: `${P} test account ${tag}` })).account;
    await must("POST", `/vendors/${v.id}/credentials`, { vendorAccountId: acct.id, credentialType: "api-key", secret: TEST_SECRET });
    return v;
  };
  await mkVendor("a", { automaticFallback: true, timeoutMs: 3000, retryMaxAttempts: 2, retryBackoffMs: 50, retryOn5xx: true });
  await mkVendor("b", { automaticFallback: true, timeoutMs: 3000, retryMaxAttempts: 1, retryBackoffMs: 50, retryOn5xx: true });
  const mkModel = async (vt, scenario) => {
    const m = (await must("POST", "/models", { vendorId: ids.vendors[vt], providerModelId: scenario, inhouseAlias: `${P}-${vt}-${scenario}`, displayName: `${P} ${vt} ${scenario}`, status: "enabled" })).model;
    await must("PUT", `/models/${m.id}/workloads`, { workloadIds: Object.values(ids.workloads) });
    ids.models[`${vt}:${scenario}`] = m;
    return m;
  };
  for (const s of ["mock-ok", "mock-tools", "mock-retry-once", "mock-fail-503", "mock-fail-400", "mock-fail-401", "mock-fail-429", "mock-slow", "mock-stream-idle", "mock-stream-flood"]) await mkModel("a", s);
  await mkModel("b", "mock-ok");
  await mkModel("b", "mock-fail-503");
  const tier = async (w, vt, scenario, n, key) => {
    const t = (await must("POST", `/routing/workloads/${ids.workloads[w]}/tiers`, { vendorId: ids.vendors[vt], modelId: ids.models[`${vt}:${scenario}`].id, tierNumber: n, priority: 10, enabled: true })).tier;
    ids.tiers[key ?? `${w}:${vt}:${scenario}`] = t.id;
    return t;
  };
  let n = 1;
  for (const s of ["mock-ok", "mock-tools", "mock-retry-once", "mock-fail-503", "mock-fail-400", "mock-fail-401", "mock-fail-429", "mock-slow", "mock-stream-idle", "mock-stream-flood"]) await tier("main", "a", s, n++);
  const rule = (w, from, to, cond) => must("POST", `/routing/workloads/${ids.workloads[w]}/fallback-rules`, { fromTierId: ids.tiers[from], toTierId: ids.tiers[to], conditionType: cond, priority: 10, enabled: true });
  await tier("fallback", "a", "mock-fail-503", 1); await tier("fallback", "b", "mock-ok", 2);
  await rule("fallback", "fallback:a:mock-fail-503", "fallback:b:mock-ok", "on_5xx");
  await tier("fallback-nomatch", "a", "mock-fail-400", 1); await tier("fallback-nomatch", "b", "mock-ok", 2);
  await rule("fallback-nomatch", "fallback-nomatch:a:mock-fail-400", "fallback-nomatch:b:mock-ok", "on_5xx");
  await tier("fallback-loop", "a", "mock-fail-503", 1); await tier("fallback-loop", "b", "mock-fail-503", 2);
  await rule("fallback-loop", "fallback-loop:a:mock-fail-503", "fallback-loop:b:mock-fail-503", "on_error");
  await rule("fallback-loop", "fallback-loop:b:mock-fail-503", "fallback-loop:a:mock-fail-503", "on_error");
  await tier("cancel", "a", "mock-slow", 1); await tier("cancel", "b", "mock-ok", 2);
  await rule("cancel", "cancel:a:mock-slow", "cancel:b:mock-ok", "on_error");
  await tier("denied", "a", "mock-ok", 1);

  const granted = ["main", "fallback", "fallback-nomatch", "fallback-loop", "cancel"].map((w) => ids.workloads[w]);
  const key = await must("POST", "/api-keys", { name: `${P} test key (disposable)`, workloadIds: granted });
  CLIENT_KEY = key.rawKey; ids.keyId = key.apiKey.id;
  console.log("seeded: workloads", Object.keys(ids.workloads).length, "vendors 2, models", Object.keys(ids.models).length, "key", key.apiKey.keyId);
}
const alias = (vt, s) => `${P}-${vt}-${s}`;
const W = (k) => ids.workloads[k];

// ---------- tests ----------
async function testAuth() {
  console.log("\n== AUTH / AUTHORIZATION ==");
  const body = { workloadId: W("main"), model: alias("a", "mock-ok"), messages: [{ role: "user", content: "hi" }] };
  const noKey = await api("POST", "/chat/completions", body, null);
  check("auth", "no key -> 401", noKey.status === 401, noKey.status);
  const badKey = await api("POST", "/chat/completions", body, "ihk_notarealkey");
  check("auth", "bad key -> 401", badKey.status === 401, badKey.status);
  const adminAsClient = await api("POST", "/chat/completions", body, ADMIN);
  check("auth", "admin token cannot execute -> 401", adminAsClient.status === 401, adminAsClient.status);
  const clientAsAdmin = await api("GET", "/vendors", null, CLIENT_KEY);
  check("auth", "client key cannot use control plane -> 401", clientAsAdmin.status === 401, clientAsAdmin.status);
  const xkey = await api("POST", "/chat/completions", body, null, { "x-api-key": CLIENT_KEY });
  check("auth", "x-api-key header accepted through proxy", xkey.status === 200, xkey.status);
  const denied = await chat(W("denied"), alias("a", "mock-ok"));
  check("auth", "workload not granted -> 403 WORKLOAD_NOT_PERMITTED", denied.status === 403 && denied.json?.error?.code === "WORKLOAD_NOT_PERMITTED", `${denied.status} ${denied.text.slice(0, 120)}`);
  const hdrWl = await api("POST", "/chat/completions", { model: alias("a", "mock-ok"), messages: [{ role: "user", content: "hi" }] }, CLIENT_KEY, { "x-inhouse-workload-id": W("main") });
  check("auth", "x-inhouse-workload-id header forwarded through proxy", hdrWl.status === 200, hdrWl.status);
  const noWl = await api("POST", "/chat/completions", { model: alias("a", "mock-ok"), messages: [{ role: "user", content: "hi" }] }, CLIENT_KEY);
  check("auth", "no workload supplied -> 4xx (never inferred)", noWl.status >= 400 && noWl.status < 500, noWl.status);
}

async function testUnary() {
  console.log("\n== UNARY ==");
  mockReset();
  const requestId = rid();
  const r = await chat(W("main"), alias("a", "mock-ok"), {}, { "x-request-id": requestId });
  check("unary", "HTTP 200 through frontend proxy", r.status === 200, r.status);
  check("unary", "response content from mock provider", r.json?.choices?.[0]?.message?.content === "mock-response:mock-ok", r.text.slice(0, 200));
  check("unary", "x-request-id echoed", r.headers.get("x-request-id") === requestId, r.headers.get("x-request-id"));
  const executionId = String(r.json?.id ?? "").replace("chatcmpl-", "");
  check("unary", "execution id present", /^[0-9a-f-]{36}$/.test(executionId), r.json?.id);
  const rows = await waitLedger(requestId);
  check("unary", "exactly one ledger row", rows.length === 1, rows.length);
  const row = rows[0] ?? {};
  check("unary", "ledger: execution_id/request_id coherent", row.executionId === executionId && row.requestId === requestId, JSON.stringify(row));
  check("unary", "ledger: success, attempt_count=1, not fallback", row.status === "success" && row.attemptCount === 1 && row.isFallback === false, JSON.stringify(row));
  check("unary", "ledger: provider_request_id preserved", /^mock-req-\d+$/.test(row.providerRequestId ?? ""), row.providerRequestId);
  check("unary", "ledger: tokens as reported by provider (11/7/18)", row.inputTokens === 11 && row.outputTokens === 7 && row.totalTokens === 18, JSON.stringify(row));
  check("unary", "ledger: workload/model/key attribution", row.workloadId === W("main") && row.modelId === ids.models["a:mock-ok"].id && row.inhouseApiKeyId === ids.keyId, JSON.stringify(row));
  const h = hits("mock-ok");
  check("unary", "mock provider received exactly 1 request", h.length === 1, h.length);
  check("unary", "credential decrypted at execution boundary and reached provider (secret hash matches)", h[0]?.authSha256 === secretTag, `${h[0]?.authSha256} vs ${secretTag}`);
  check("unary", "response/ledger contain no secret", !r.text.includes(TEST_SECRET) && !JSON.stringify(rows).includes(TEST_SECRET));
  const anth = await api("POST", "/messages", { workloadId: W("main"), model: alias("a", "mock-ok"), max_tokens: 50, messages: [{ role: "user", content: "hi" }] }, null, { "x-api-key": CLIENT_KEY });
  check("unary", "Anthropic-compatible /v1/messages works through proxy", anth.status === 200 && anth.json?.content?.[0]?.text === "mock-response:mock-ok", `${anth.status} ${anth.text.slice(0, 160)}`);
}

async function testStreaming() {
  console.log("\n== STREAMING ==");
  mockReset();
  const s = await sse(W("main"), alias("a", "mock-ok"));
  check("stream", "HTTP 200 text/event-stream via proxy", s.status === 200 && /text\/event-stream/.test(s.contentType ?? ""), `${s.status} ${s.contentType}`);
  check("stream", "content deltas arrive and reassemble", streamText(s) === "mock-response:mock-ok", streamText(s));
  check("stream", "finish reason + [DONE] terminator", s.done && s.frames.some((f) => f.choices?.[0]?.finish_reason === "stop"), JSON.stringify(s.frames.slice(-2)));
  check("stream", "multiple network chunks (not buffered into one)", s.arrivals.length >= 2, s.arrivals.length);
  const rows = await waitLedger(s.requestId);
  check("stream", "one ledger row, success, tokens recorded", rows.length === 1 && rows[0].status === "success" && rows[0].totalTokens === 18, JSON.stringify(rows));
  check("stream", "stream: no secret exposed", !JSON.stringify(s.frames).includes(TEST_SECRET));

  const idle = await sse(W("main"), alias("a", "mock-stream-idle"), { maxMs: 20_000 });
  check("stream", "idle timeout fires (~3s vendor timeout) and stream terminates with error", idle.ms < 12_000 && (idle.errorFrame || !idle.done) && idle.ms >= 2500, `ms=${idle.ms} errorFrame=${idle.errorFrame} done=${idle.done}`);
  const idleRows = await waitLedger(idle.requestId);
  check("stream", "idle-timeout ledger row is error/timeout", idleRows.length === 1 && idleRows[0].status === "error" && idleRows[0].errorCategory === "timeout", JSON.stringify(idleRows));

  const flood = await sse(W("main"), alias("a", "mock-stream-flood"), { maxMs: 60_000 });
  check("stream", `byte cap enforced (stopped at ${flood.bytes} bytes with error frame)`, flood.errorFrame && flood.bytes > 7_000_000 && flood.bytes < 20_000_000, `bytes=${flood.bytes} err=${flood.errorFrame}`);
  const floodRows = await waitLedger(flood.requestId);
  check("stream", "flood ledger row is error", floodRows.length === 1 && floodRows[0].status === "error", JSON.stringify(floodRows));
  console.log("NOTE  absolute 600s duration cap not exercised live (would take 10 min); covered by unit tests only.");
}

async function testTools() {
  console.log("\n== TOOLS ==");
  mockReset();
  const tools = [{ type: "function", function: { name: "lookup_city", description: "test tool", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
  const requestId = rid();
  const r = await chat(W("main"), alias("a", "mock-tools"), { tools }, { "x-request-id": requestId });
  const tc = r.json?.choices?.[0]?.message?.tool_calls?.[0];
  check("tools", "tool call returned to client", r.status === 200 && tc?.function?.name === "lookup_city" && tc?.function?.arguments === '{"city":"Testville"}' && r.json.choices[0].finish_reason === "tool_calls", r.text.slice(0, 250));
  check("tools", "tool definitions reached provider", mockLog().some((e) => e.model === "mock-tools" && e.hasTools === true));
  const rows = await waitLedger(requestId);
  check("tools", "ledger row success", rows.length === 1 && rows[0].status === "success", JSON.stringify(rows));
  const requestId2 = rid();
  const cont = await api("POST", "/chat/completions", {
    workloadId: W("main"), model: alias("a", "mock-tools"), tools,
    messages: [
      { role: "user", content: `${P}-tools-turn` },
      { role: "assistant", content: "", tool_calls: [tc] },
      { role: "tool", tool_call_id: tc.id, content: "sunny" },
    ],
  }, CLIENT_KEY, { "x-request-id": requestId2 });
  check("tools", "multi-turn continuation with tool result works", cont.status === 200 && cont.json?.choices?.[0]?.message?.content === "tool-result-received:sunny", cont.text.slice(0, 250));
  check("tools", "tool result reached provider", mockLog().some((e) => e.model === "mock-tools" && e.toolResultSeen === true));
  check("tools", "continuation has its own ledger row", (await waitLedger(requestId2)).length === 1);
  const s = await sse(W("main"), alias("a", "mock-tools"), { extra: { tools } });
  const args = s.frames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls ?? []).map((t) => t.function?.arguments ?? "").join("");
  check("tools", "streamed tool call reassembles", args === '{"city":"Testville"}' && s.done, `${args} done=${s.done}`);
  const badPair = await api("POST", "/chat/completions", { workloadId: W("main"), model: alias("a", "mock-tools"), messages: [{ role: "user", content: "x" }, { role: "tool", tool_call_id: "nope", content: "y" }] }, CLIENT_KEY);
  check("tools", "orphan tool result rejected (400)", badPair.status === 400, badPair.status);
}

async function testRetryAndFailures() {
  console.log("\n== RETRY / PROVIDER FAILURE ==");
  mockReset();
  let requestId = rid();
  const r = await chat(W("main"), alias("a", "mock-retry-once"), {}, { "x-request-id": requestId });
  check("retry", "attempt 1 fails (503), attempt 2 succeeds -> 200 to client", r.status === 200 && r.json?.choices?.[0]?.message?.content === "mock-response:mock-retry-once", `${r.status} ${r.text.slice(0, 160)}`);
  let rows = await waitLedger(requestId);
  check("retry", "ledger attempt_count=2, success, no fallback", rows.length === 1 && rows[0].attemptCount === 2 && rows[0].status === "success" && rows[0].isFallback === false, JSON.stringify(rows));
  check("retry", "mock saw exactly 2 attempts (503 then 200)", (() => { const h = hits("mock-retry-once"); return h.length === 2 && h[0].status === 503 && h[1].status === 200; })(), JSON.stringify(hits("mock-retry-once").map((h) => h.status)));

  mockReset(); requestId = rid();
  const f = await chat(W("main"), alias("a", "mock-fail-503"), {}, { "x-request-id": requestId });
  check("retry", "persistent 503: bounded at maxAttempts=2 (no infinite loop)", hits("mock-fail-503").length === 2, hits("mock-fail-503").length);
  check("failure", "503 -> client error (503) with category/requestId/executionId, no provider body", f.status === 503 && f.json?.error?.requestId === requestId && !!f.json?.error?.executionId && !f.text.includes("mock unavailable"), `${f.status} ${f.text.slice(0, 200)}`);
  rows = await waitLedger(requestId);
  check("failure", "ledger: error / unavailable / attempt_count=2", rows.length === 1 && rows[0].status === "error" && rows[0].errorCategory === "unavailable" && rows[0].attemptCount === 2, JSON.stringify(rows));

  for (const [scenario, wantStatus, wantCat, wantHits] of [["mock-fail-400", 400, "invalid_request", 1], ["mock-fail-401", 502, "authentication", 1], ["mock-fail-429", 429, "rate_limit", 1]]) {
    mockReset(); requestId = rid();
    const x = await chat(W("main"), alias("a", scenario), {}, { "x-request-id": requestId });
    check("failure", `${scenario}: client ${wantStatus}, not retried (${wantHits} provider hit)`, x.status === wantStatus && hits(scenario).length === wantHits, `${x.status} hits=${hits(scenario).length} ${x.text.slice(0, 120)}`);
    rows = await waitLedger(requestId);
    check("failure", `${scenario}: ledger error/${wantCat}, attempt_count=1`, rows.length === 1 && rows[0].errorCategory === wantCat && rows[0].attemptCount === 1, JSON.stringify(rows));
    check("failure", `${scenario}: provider error body not leaked`, !/mock (bad key|invalid request|rate limited)/.test(x.text));
  }

  mockReset(); requestId = rid();
  const t0 = Date.now();
  const to = await chat(W("main"), alias("a", "mock-slow"), {}, { "x-request-id": requestId });
  check("failure", "provider timeout (~3s) -> 504, ledger error/timeout, not retried", to.status === 504 && Date.now() - t0 < 10_000 && (await waitLedger(requestId))[0]?.errorCategory === "timeout" && hits("mock-slow").length === 1, `${to.status} ${Date.now() - t0}ms`);
}

async function testFallback() {
  console.log("\n== FALLBACK ==");
  mockReset();
  let requestId = rid();
  const r = await chat(W("fallback"), alias("a", "mock-fail-503"), {}, { "x-request-id": requestId });
  check("fallback", "primary fails, fallback tier succeeds -> 200", r.status === 200 && r.json?.choices?.[0]?.message?.content === "mock-response:mock-ok", `${r.status} ${r.text.slice(0, 160)}`);
  const log = mockLog().filter((e) => e.path === "/v1/chat/completions");
  check("fallback", "primary attempted (2x, retry) then fallback executed (1x)", log.filter((e) => e.model === "mock-fail-503").length === 2 && log.filter((e) => e.model === "mock-ok").length === 1, JSON.stringify(log.map((e) => `${e.model}:${e.status}`)));
  const rows = await waitLedger(requestId);
  const row = rows[0] ?? {};
  check("fallback", "ledger: is_fallback, attempt_count=3, primary/fallback tiers recorded", rows.length === 1 && row.isFallback === true && row.attemptCount === 3 && row.primaryTierId === ids.tiers["fallback:a:mock-fail-503"] && row.fallbackTierId === ids.tiers["fallback:b:mock-ok"] && row.status === "success", JSON.stringify(row));
  check("fallback", "ledger: served by fallback vendor's model", row.modelId === ids.models["b:mock-ok"].id, row.modelId);

  mockReset(); requestId = rid();
  const nm = await chat(W("fallback-nomatch"), alias("a", "mock-fail-400"), {}, { "x-request-id": requestId });
  check("fallback", "non-matching failure (400 vs on_5xx rule): no fallback", nm.status === 400 && hits("mock-ok").length === 0 && hits("mock-fail-400").length === 1, `${nm.status} ok-hits=${hits("mock-ok").length}`);
  check("fallback", "non-matching: ledger not fallback, attempt_count=1", (await waitLedger(requestId))[0]?.isFallback === false);

  mockReset(); requestId = rid();
  const loop = await chat(W("fallback-loop"), alias("a", "mock-fail-503"), {}, { "x-request-id": requestId });
  const total = mockLog().filter((e) => e.path === "/v1/chat/completions").length;
  check("fallback", `cyclic fallback rules terminate (provider hits=${total} <= 3, tier visited once)`, loop.status >= 500 && total === 3, `${loop.status} hits=${total}`);
  const lrows = await waitLedger(requestId);
  check("fallback", "cyclic: single ledger row, error, attempt_count=3", lrows.length === 1 && lrows[0].status === "error" && lrows[0].attemptCount === 3, JSON.stringify(lrows));

  mockReset(); requestId = rid();
  const s = await sse(W("fallback"), alias("a", "mock-fail-503"), { requestId });
  check("fallback", "streaming: pre-first-byte failure still falls back", s.status === 200 && streamText(s) === "mock-response:mock-ok" && s.done, `${s.status} ${streamText(s)}`);
  const srow = (await waitLedger(requestId))[0] ?? {};
  check("fallback", "streaming fallback ledger", srow.isFallback === true && srow.status === "success", JSON.stringify(srow));
}

async function testCancellation() {
  console.log("\n== CANCELLATION ==");
  mockReset();
  let requestId = rid();
  const ctrl = new AbortController();
  const p = fetch(`${BASE}/chat/completions`, {
    method: "POST", signal: ctrl.signal,
    headers: { Authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({ workloadId: W("cancel"), model: alias("a", "mock-slow"), messages: [{ role: "user", content: `${P}-cancel` }] }),
  }).catch((e) => e.name);
  await sleep(700);
  ctrl.abort();
  check("cancel", "client aborted mid-request", (await p) === "AbortError");
  let rows = await waitLedger(requestId, 8000);
  await sleep(1500);
  const log = mockLog().filter((e) => e.path === "/v1/chat/completions");
  check("cancel", "mock provider observed the outbound request being aborted", log.length >= 1 && log[0].aborted === true, JSON.stringify(log));
  check("cancel", "retries stopped (exactly 1 provider hit)", log.filter((e) => e.model === "mock-slow").length === 1, log.length);
  check("cancel", "fallback did not continue (no provider hit on fallback tier)", log.filter((e) => e.model === "mock-ok").length === 0);
  rows = await ledgerFor(requestId);
  check("cancel", "ledger: one row, error/cancelled, attempt_count=1", rows.length === 1 && rows[0].errorCategory === "cancelled" && rows[0].attemptCount === 1, JSON.stringify(rows));

  mockReset(); requestId = rid();
  const s = await sse(W("main"), alias("a", "mock-stream-idle"), { abortAfterFirstChunk: true, requestId });
  check("cancel", "streaming: got first chunk then client disconnected", s.aborted && s.frames.length >= 1);
  await sleep(1500);
  check("cancel", "streaming: mock provider observed abort", hits("mock-stream-idle").some((e) => e.aborted === true), JSON.stringify(mockLog()));
  const srows = await waitLedger(requestId, 6000);
  check("cancel", "streaming: ledger recorded cancelled, one row", srows.length === 1 && srows[0].errorCategory === "cancelled", JSON.stringify(srows));
  check("cancel", "streaming: no retry after cancel (1 provider hit)", hits("mock-stream-idle").length === 1, hits("mock-stream-idle").length);
}

const counts = () => ({
  migrations: Number(psql("SELECT count(*) FROM inhouse.schema_migrations")),
  vendors: Number(psql(`SELECT count(*) FROM inhouse.vendors WHERE slug LIKE '${P}%'`)),
  accounts: Number(psql(`SELECT count(*) FROM inhouse.vendor_accounts WHERE slug LIKE '${P}%'`)),
  models: Number(psql(`SELECT count(*) FROM inhouse.models WHERE inhouse_alias LIKE '${P}%'`)),
  workloads: Number(psql(`SELECT count(*) FROM inhouse.workloads WHERE slug LIKE '${P}%'`)),
  keys: Number(psql(`SELECT count(*) FROM inhouse.inhouse_api_keys WHERE name LIKE '${P}%'`)),
  grants: Number(psql(`SELECT count(*) FROM inhouse.inhouse_api_key_workloads g JOIN inhouse.inhouse_api_keys k ON k.id=g.api_key_id WHERE k.name LIKE '${P}%'`)),
  tiers: Number(psql(`SELECT count(*) FROM inhouse.routing_tiers t JOIN inhouse.workloads w ON w.id=t.workload_id WHERE w.slug LIKE '${P}%'`)),
  rules: Number(psql(`SELECT count(*) FROM inhouse.routing_fallback_rules t JOIN inhouse.workloads w ON w.id=t.workload_id WHERE w.slug LIKE '${P}%'`)),
  credentials: Number(psql(`SELECT count(*) FROM inhouse.vendor_credentials c JOIN inhouse.vendor_accounts a ON a.id=c.vendor_account_id WHERE a.slug LIKE '${P}%'`)),
  ledger: Number(psql(`SELECT count(*) FROM inhouse.usage_ledger WHERE request_id LIKE '${P}%'`)),
});

async function testRestart() {
  console.log("\n== RESTART PERSISTENCE (Inhouse containers only) ==");
  const before = counts();
  console.log("before:", JSON.stringify(before));
  sh("docker", [...COMPOSE, "restart", "inhouse-frontend", "inhouse-api", "inhouse-postgres", "inhouse-mock-provider"], { stdio: "pipe" });
  for (let i = 0; i < 60; i++) {
    const st = ["inhouse-frontend", "inhouse-api", "inhouse-postgres", "inhouse-mock-provider"].map((c) => sh("docker", ["inspect", "-f", "{{.State.Health.Status}}", c]).trim());
    if (st.every((s) => s === "healthy")) break;
    await sleep(2000);
  }
  await sleep(1000);
  const after = counts();
  console.log("after: ", JSON.stringify(after));
  check("restart", "all Inhouse containers healthy after restart", ["inhouse-frontend", "inhouse-api", "inhouse-postgres", "inhouse-mock-provider"].every((c) => sh("docker", ["inspect", "-f", "{{.State.Health.Status}}", c]).trim() === "healthy"));
  check("restart", "migrations still applied (same count)", after.migrations === before.migrations && after.migrations > 0, `${before.migrations}/${after.migrations}`);
  for (const k of ["vendors", "accounts", "models", "workloads", "keys", "grants", "tiers", "rules", "credentials", "ledger"]) check("restart", `${k} persisted (${before[k]})`, after[k] === before[k] && before[k] > 0, `${before[k]} -> ${after[k]}`);
  const admin = await api("GET", "/vendors");
  check("restart", "admin authentication still works via proxy", admin.status === 200 && admin.json.vendors.some((v) => v.slug.startsWith(P)));
  const rows = await ledgerAll();
  check("restart", "usage ledger readable after restart", rows.some((r) => r.requestId?.startsWith(P)));
  mockReset();
  const requestId = rid();
  const r = await chat(W("main"), alias("a", "mock-ok"), {}, { "x-request-id": requestId });
  check("restart", "client key + vault credential + execution work after restart", r.status === 200 && hits("mock-ok")[0]?.authSha256 === secretTag, `${r.status} ${r.text.slice(0, 120)}`);
  check("restart", "post-restart request ledgered", (await waitLedger(requestId)).length === 1);
}

function scanLogs() {
  console.log("\n== SECRET / LOG SCAN ==");
  const needles = { "test provider secret": TEST_SECRET, "admin token": ADMIN, "client key": CLIENT_KEY };
  for (const c of ["inhouse-api", "inhouse-frontend", "inhouse-mock-provider", "inhouse-postgres"]) {
    const r = spawnSync("docker", ["logs", c], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const all = `${r.stdout}${r.stderr}`;
    for (const [label, n] of Object.entries(needles)) check("security", `${c} logs contain no ${label}`, !all.includes(n));
    check("security", `${c} logs non-empty (scan meaningful)`, c === "inhouse-postgres" || all.length > 100, all.length);
  }
  const dump = psql("SELECT row_to_json(t)::text FROM inhouse.usage_ledger t") + psql("SELECT row_to_json(t)::text FROM inhouse.audit_events t");
  check("security", "usage_ledger + audit_events contain no raw secrets", !dump.includes(TEST_SECRET) && !dump.includes(ADMIN) && !dump.includes(CLIENT_KEY));
  const cred = psql(`SELECT row_to_json(c)::text FROM inhouse.vendor_credentials c JOIN inhouse.vendor_accounts a ON a.id=c.vendor_account_id WHERE a.slug LIKE '${P}%'`);
  check("security", "stored credential is encrypted (no plaintext column)", !cred.includes(TEST_SECRET));
}

async function testFrontendNoSecrets() {
  const vendors = await api("GET", "/vendors"); const creds = await api("GET", `/vendors/${ids.vendors.a}/credentials`);
  check("security", "control-plane credential listing never returns the secret", !vendors.text.includes(TEST_SECRET) && !creds.text.includes(TEST_SECRET), creds.text.slice(0, 200));
}

async function cleanup() {
  console.log("\n== CLEANUP (only this run's disposable data) ==");
  // Ledger rows referencing our workloads are set NULL by FK; delete explicitly by request-id prefix (unique to this run).
  psql(`DELETE FROM inhouse.usage_ledger WHERE request_id LIKE '${P}%' OR workload_id IN (SELECT id FROM inhouse.workloads WHERE slug LIKE '${P}%')`);
  psql(`DELETE FROM inhouse.inhouse_api_keys WHERE name LIKE '${P}%'`);
  psql(`DELETE FROM inhouse.workloads WHERE slug LIKE '${P}%' AND description LIKE 'BLOCK13 E2E DISPOSABLE%'`);
  psql(`DELETE FROM inhouse.vendors WHERE slug LIKE '${P}%' AND description LIKE 'BLOCK13 E2E DISPOSABLE%'`);
  const left = psql(`SELECT (SELECT count(*) FROM inhouse.workloads WHERE slug LIKE '${P}%')||','||(SELECT count(*) FROM inhouse.vendors WHERE slug LIKE '${P}%')||','||(SELECT count(*) FROM inhouse.models WHERE inhouse_alias LIKE '${P}%')||','||(SELECT count(*) FROM inhouse.vendor_accounts WHERE slug LIKE '${P}%')||','||(SELECT count(*) FROM inhouse.inhouse_api_keys WHERE name LIKE '${P}%')`);
  check("cleanup", `no ${P} workloads/vendors/models/accounts/keys remain`, left === "0,0,0,0,0", left);
  const orphanCreds = psql(`SELECT count(*) FROM inhouse.vendor_credentials c WHERE NOT EXISTS (SELECT 1 FROM inhouse.vendor_accounts a WHERE a.id=c.vendor_account_id)`);
  check("cleanup", "no orphan credentials", orphanCreds === "0", orphanCreds);
}

// ---------- main ----------
if (process.env.E2E_CLEANUP_PREFIX) { await cleanup(); process.exit(results.some((r) => !r.ok) ? 1 : 0); }
try {
  await seed();
  await testAuth();
  await testUnary();
  await testStreaming();
  await testTools();
  await testRetryAndFailures();
  await testFallback();
  await testCancellation();
  await testFrontendNoSecrets();
  await testRestart();
  scanLogs();
  if (!KEEP) {
    await cleanup();
    const after = await api("POST", "/chat/completions", { workloadId: W("main"), model: alias("a", "mock-ok"), messages: [{ role: "user", content: "x" }] }, CLIENT_KEY);
    check("cleanup", "deleted key no longer authenticates (401)", after.status === 401, after.status);
  }
} catch (e) {
  check("driver", "unhandled error", false, e.stack);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n== SUMMARY: ${results.length - failed.length}/${results.length} passed ==`);
for (const f of failed) console.log(`FAILED [${f.group}] ${f.name} -> ${f.detail}`);
process.exit(failed.length ? 1 : 0);
