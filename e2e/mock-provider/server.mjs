// TEST-ONLY mock provider for Inhouse Block 13 live E2E.
//
// Speaks just enough of the OpenAI-compatible wire protocol
// (GET /v1/models, POST /v1/chat/completions) for the real, unchanged
// ProviderAdapter to talk to it. It is NOT part of the production image or
// the production compose file, holds no real vendor logic and needs no
// real credential. Behavior is data-driven: the scenario is selected by
// the provider-facing model id the request carries (a `models` row in the
// Inhouse database), never by any routing logic in Inhouse.
//
// Observability: GET /_mock/log returns per-request records (model,
// stream, aborted, status, SHA-256 prefix of the bearer secret). Message
// content and the raw bearer secret are never recorded. POST /_mock/reset
// clears log and counters. The container publishes no host port; the
// driver reaches these endpoints via `docker exec`.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PROVIDER_PORT ?? 9000);
const SLOW_MS = Number(process.env.MOCK_SLOW_MS ?? 30_000);
const log = [];
const counters = new Map();

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
// NOTE: `req` "close" fires once the request body is read (Node >= 16), so
// client disconnects must be observed on the *response* ("close" before the
// response has ended).
const sleep = (ms, res) =>
  new Promise((resolve) => {
    if (res.destroyed) return resolve(false);
    const t = setTimeout(() => resolve(true), ms);
    res.on("close", () => {
      clearTimeout(t);
      resolve(false);
    });
  });

function completion(model, id, message, finish) {
  return {
    id,
    object: "chat.completion",
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

function toolReply(body) {
  const last = body.messages[body.messages.length - 1];
  if (last?.role === "tool") {
    return { text: `tool-result-received:${String(last.content).slice(0, 60)}`, toolCalls: null };
  }
  const tool = Array.isArray(body.tools) ? body.tools[0] : null;
  if (!tool) return { text: "no-tools-offered", toolCalls: null };
  return {
    text: "",
    toolCalls: [{ id: "call_mock_1", type: "function", function: { name: tool.function.name, arguments: '{"city":"Testville"}' } }],
  };
}

async function handleChat(req, res, entry) {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ") || auth.length < 12) {
    entry.status = 401;
    return json(res, 401, { error: { message: "missing bearer" } });
  }
  entry.authSha256 = sha(auth.slice(7));
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    entry.status = 400;
    return json(res, 400, { error: { message: "bad json" } });
  }
  const model = String(body.model ?? "");
  const stream = body.stream === true;
  Object.assign(entry, { model, stream, hasTools: Array.isArray(body.tools) && body.tools.length > 0 });
  entry.toolResultSeen = body.messages?.some((m) => m.role === "tool") ?? false;
  const firstUser = body.messages?.find((m) => m.role === "user")?.content ?? "";
  const id = `mock-req-${entry.n}`;
  res.on("close", () => {
    if (!res.writableEnded) entry.aborted = true;
  });

  const fail = (status, msg) => {
    entry.status = status;
    return json(res, status, { error: { message: msg } });
  };

  switch (model) {
    case "mock-fail-503":
      return fail(503, "mock unavailable");
    case "mock-fail-400":
      return fail(400, "mock invalid request");
    case "mock-fail-401":
      return fail(401, "mock bad key");
    case "mock-fail-429":
      return fail(429, "mock rate limited");
    case "mock-retry-once": {
      const key = `retry:${sha(String(firstUser))}`;
      const seen = (counters.get(key) ?? 0) + 1;
      counters.set(key, seen);
      if (seen === 1) return fail(503, "mock first attempt fails");
      break;
    }
    case "mock-slow":
      if (!(await sleep(SLOW_MS, res))) return; // client went away: aborted recorded above
      break;
    default:
      break;
  }

  entry.status = 200;
  const tools = model === "mock-tools" ? toolReply(body) : null;
  const text = tools ? tools.text : `mock-response:${model}`;
  const toolCalls = tools?.toolCalls ?? null;
  const finish = toolCalls ? "tool_calls" : "stop";

  if (!stream) {
    return json(res, 200, completion(model, id, { role: "assistant", content: text || null, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish));
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const send = (obj) => res.write(`data: ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n\n`);
  const chunk = (delta, fin = null, extra = {}) => ({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: fin }], ...extra });

  if (model === "mock-stream-idle") {
    send(chunk({ content: "partial" }));
    await sleep(10 * 60_000, res); // stall: the adapter's idle timeout must fire
    return;
  }
  if (model === "mock-stream-flood") {
    const filler = "x".repeat(60_000);
    while (!res.destroyed) {
      if (!res.write(`data: ${JSON.stringify(chunk({ content: filler }))}\n\n`)) await new Promise((r) => res.once("drain", r).once("close", r));
    }
    return;
  }
  if (toolCalls) {
    const tc = toolCalls[0];
    send(chunk({ tool_calls: [{ index: 0, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }));
    send(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }));
    send(chunk({ tool_calls: [{ index: 0, function: { arguments: '"Testville"}' } }] }));
  } else {
    for (const part of [`mock-response:`, model]) {
      send(chunk({ content: part }));
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  send(chunk({}, finish, { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }));
  send("[DONE]");
  res.end();
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  if (url.pathname === "/_mock/log") return json(res, 200, { log });
  if (url.pathname === "/_mock/reset" && req.method === "POST") {
    log.length = 0;
    counters.clear();
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/_mock/healthz") return json(res, 200, { ok: true });

  const entry = { n: log.length + 1, ts: new Date().toISOString(), method: req.method, path: url.pathname, aborted: false, status: null };
  log.push(entry);
  try {
    if (req.method === "GET" && url.pathname === "/v1/models") {
      entry.status = 200;
      return json(res, 200, { data: [{ id: "mock-ok" }] });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") return await handleChat(req, res, entry);
    entry.status = 404;
    return json(res, 404, { error: { message: "not found" } });
  } catch (err) {
    entry.status = 500;
    if (!res.headersSent) json(res, 500, { error: { message: "mock error" } });
    else res.end();
  }
}).listen(PORT, "0.0.0.0", () => console.log(`inhouse-mock-provider (TEST ONLY) listening on ${PORT}`));
