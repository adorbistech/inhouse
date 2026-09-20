import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ADMIN, TEST_ADMIN_TOKEN, TEST_VAULT_KEY, truncateAll, withMigratedApp, withMigratedPool } from "./helpers.js";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { CredentialVaultService } from "../../src/lib/credentialVault.js";
import { UsageLedgerRepository } from "../../src/repositories/usageLedgerRepository.js";
import { AdapterRegistry } from "../../src/services/adapters/adapterRegistry.js";
import { OpenAiCompatibleAdapter } from "../../src/services/adapters/openAiCompatibleAdapter.js";
import type { ProviderAdapter } from "../../src/services/providerAdapter.js";
import {
  REAL_SECRET,
  createAccountAndCredential,
  createApiKey,
  createModel,
  createTier,
  createVendor,
  createWorkload,
  attachModelToWorkload,
  attachVendorToWorkload,
  setUpEligibleTier,
  startMockProviderServer,
  type MockBehavior,
} from "./executionSupport.js";

// ------------------------------------------------------------------ helpers

interface Ctx {
  app: FastifyInstance;
  pool: Pool;
  workloadId: string;
  alias: string;
  rawKey: string;
  server: Awaited<ReturnType<typeof startMockProviderServer>>;
}

/** One workload, one eligible tier against a mock provider with the given behavior, one granted key. */
async function withScenario(
  behavior: MockBehavior,
  fn: (c: Ctx) => Promise<void>,
  opts: { vendorOverrides?: Record<string, unknown> } = {},
): Promise<void> {
  const server = await startMockProviderServer(behavior);
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      const { model } = await setUpEligibleTier(app, workload.id, server.baseEndpoint, { vendorOverrides: opts.vendorOverrides });
      const { rawKey } = await createApiKey(app, [workload.id]);
      await fn({ app, pool, workloadId: workload.id, alias: model.inhouseAlias as string, rawKey, server });
    });
  } finally {
    await server.close();
  }
}

const bearer = (rawKey: string) => ({ authorization: `Bearer ${rawKey}` });

function openAi(c: Ctx, extra: Record<string, unknown> = {}) {
  return c.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: bearer(c.rawKey),
    payload: { workloadId: c.workloadId, model: c.alias, messages: [{ role: "user", content: "hi" }], ...extra },
  });
}

function anthropic(c: Ctx, extra: Record<string, unknown> = {}) {
  return c.app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": c.rawKey, "anthropic-version": "2023-06-01" },
    payload: { workloadId: c.workloadId, model: c.alias, max_tokens: 64, messages: [{ role: "user", content: "hi" }], ...extra },
  });
}

function parseSse(body: string): Array<{ event: string | null; data: string }> {
  return body
    .split("\n\n")
    .filter((b) => b.trim().length > 0)
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? null;
      const data = [...block.matchAll(/^data: ?(.*)$/gm)].map((m) => m[1]).join("\n");
      return { event, data };
    });
}

const ledger = (pool: Pool) => new UsageLedgerRepository(pool).listRecent(20);

async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail("condition not met in time");
}

// ------------------------------------------------------------ streaming

test("OpenAI streaming: SSE chunks in order, finish_reason, provider usage, [DONE]; one ledger row with the provider's token counts", async () => {
  await withScenario("stream", async (c) => {
    const res = await openAi(c, { stream: true });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(String(res.headers["content-type"]), /text\/event-stream/);
    assert.ok(res.headers["x-request-id"]);

    const frames = parseSse(res.body);
    assert.equal(frames[frames.length - 1]?.data, "[DONE]");
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f.data) as { choices: Array<{ delta: { content?: string; role?: string }; finish_reason: string | null }>; usage?: unknown });
    assert.equal(chunks[0]?.choices[0]?.delta.role, "assistant");
    const text = chunks.map((k) => k.choices[0]?.delta.content ?? "").join("");
    assert.equal(text, "Hello stream");
    assert.ok(chunks.some((k) => k.choices[0]?.finish_reason === "stop"));
    assert.deepEqual(chunks.find((k) => k.usage)?.usage, { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });

    const sent = c.server.receivedBodies[0] as { stream: boolean; stream_options: unknown };
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.stream_options, { include_usage: true });
    assert.ok(!res.body.includes(REAL_SECRET));

    await until(async () => (await ledger(c.pool)).length === 1);
    const row = (await ledger(c.pool))[0]!;
    assert.equal(row.status, "success");
    assert.deepEqual([row.input_tokens, row.output_tokens, row.total_tokens], [12, 3, 15]);
    assert.equal(row.attempt_count, 1);
  });
});

test("Anthropic streaming: message_start, content blocks, message_delta with stop_reason and usage, message_stop", async () => {
  await withScenario("stream", async (c) => {
    const res = await anthropic(c, { stream: true });
    assert.equal(res.statusCode, 200, res.body);
    const frames = parseSse(res.body);
    assert.deepEqual(
      frames.map((f) => f.event),
      ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
    );
    const start = JSON.parse(frames[0]!.data) as { message: { id: string; role: string; usage: unknown } };
    assert.match(start.message.id, /^msg_[0-9a-f]{32}$/);
    assert.equal(start.message.role, "assistant");
    const text = frames.filter((f) => f.event === "content_block_delta").map((f) => (JSON.parse(f.data) as { delta: { text: string } }).delta.text).join("");
    assert.equal(text, "Hello stream");
    const delta = JSON.parse(frames.find((f) => f.event === "message_delta")!.data) as { delta: { stop_reason: string }; usage: { output_tokens: number } };
    assert.equal(delta.delta.stop_reason, "end_turn");
    assert.equal(delta.usage.output_tokens, 3);
    assert.ok(!res.body.includes(REAL_SECRET));
  });
});

test("streaming tool calls: OpenAI tool_calls deltas and Anthropic tool_use/input_json_delta both reassemble the provider's arguments", async () => {
  await withScenario("streamTool", async (c) => {
    const oa = await openAi(c, { stream: true, tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }] });
    assert.equal(oa.statusCode, 200, oa.body);
    const oaChunks = parseSse(oa.body).slice(0, -1).map((f) => JSON.parse(f.data) as { choices: Array<{ delta: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason: string | null }> });
    const calls = oaChunks.flatMap((k) => k.choices[0]?.delta.tool_calls ?? []);
    assert.equal(calls[0]?.id, "call_1");
    assert.equal(calls[0]?.function?.name, "get_weather");
    assert.equal(calls.map((t) => t.function?.arguments ?? "").join(""), '{"city":"Oslo"}');
    assert.ok(oaChunks.some((k) => k.choices[0]?.finish_reason === "tool_calls"));

    const an = await anthropic(c, { stream: true, tools: [{ name: "get_weather", input_schema: { type: "object" } }] });
    assert.equal(an.statusCode, 200, an.body);
    const frames = parseSse(an.body);
    const blockStart = JSON.parse(frames.find((f) => f.event === "content_block_start")!.data) as { content_block: { type: string; id: string; name: string } };
    assert.deepEqual(blockStart.content_block, { type: "tool_use", id: "call_1", name: "get_weather", input: {} });
    const json = frames
      .filter((f) => f.event === "content_block_delta")
      .map((f) => (JSON.parse(f.data) as { delta: { partial_json?: string } }).delta.partial_json ?? "")
      .join("");
    assert.deepEqual(JSON.parse(json), { city: "Oslo" });
    const md = JSON.parse(frames.find((f) => f.event === "message_delta")!.data) as { delta: { stop_reason: string } };
    assert.equal(md.delta.stop_reason, "tool_use");
  });
});

test("a provider that fails before the stream opens gives a normal JSON error (not SSE), retried per the vendor's flags, and one error ledger row", async () => {
  await withScenario("serverError", async (c) => {
    const res = await openAi(c, { stream: true });
    assert.equal(res.statusCode, 502);
    assert.match(String(res.headers["content-type"]), /application\/json/);
    assert.equal(res.json().error.code, "PROVIDER_ERROR");
    const row = (await ledger(c.pool))[0]!;
    assert.equal(row.status, "error");
    assert.equal(row.error_category, "provider_error");
  });
});

test("streaming pre-open fallback: a failing primary falls back to the configured target and the stream comes from the fallback", async () => {
  const failing = await startMockProviderServer("serverError");
  const healthy = await startMockProviderServer("stream");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      const pv = await createVendor(app, failing.baseEndpoint, { automaticFallback: true });
      const pm = await createModel(app, pv.id, { inhouseAlias: `p-${Math.random().toString(36).slice(2, 8)}` });
      await attachVendorToWorkload(app, pv.id, workload.id);
      await attachModelToWorkload(app, pm.id, workload.id);
      await createAccountAndCredential(app, pv.id);
      const pt = await createTier(app, workload.id, pv.id, pm.id, { tierNumber: 0 });
      const fv = await createVendor(app, healthy.baseEndpoint);
      const fm = await createModel(app, fv.id, { inhouseAlias: `f-${Math.random().toString(36).slice(2, 8)}` });
      await attachVendorToWorkload(app, fv.id, workload.id);
      await attachModelToWorkload(app, fm.id, workload.id);
      await createAccountAndCredential(app, fv.id);
      const ft = await createTier(app, workload.id, fv.id, fm.id, { tierNumber: 1 });
      await app.inject({ headers: ADMIN, method: "POST", url: `/v1/routing/workloads/${workload.id}/fallback-rules`, payload: { fromTierId: pt.id, toTierId: ft.id, conditionType: "on_5xx", priority: 0, enabled: true } });
      const { rawKey } = await createApiKey(app, [workload.id]);

      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: bearer(rawKey),
        payload: { workloadId: workload.id, model: pm.inhouseAlias, stream: true, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.ok(res.body.includes("Hello "));
      await until(async () => (await ledger(pool)).length === 1);
      const row = (await ledger(pool))[0]!;
      assert.equal(row.is_fallback, true);
      assert.equal(row.attempt_count, 2);
      assert.equal(row.status, "success");
    });
  } finally {
    await failing.close();
    await healthy.close();
  }
});

for (const behavior of ["streamTruncated", "streamMidError"] as const) {
  test(`a stream that breaks after it opened (${behavior}) ends with a terminal safe error event and an error ledger row — never a silent success`, async () => {
    await withScenario(behavior, async (c) => {
      const oa = await openAi(c, { stream: true });
      assert.equal(oa.statusCode, 200, "headers were already committed");
      const frames = parseSse(oa.body);
      const last = frames[frames.length - 1]!;
      assert.equal(last.data, "[DONE]");
      const errorFrame = JSON.parse(frames[frames.length - 2]!.data) as { error: { code: string; message: string; requestId: string } };
      assert.ok(["PROVIDER_ERROR", "NETWORK"].includes(errorFrame.error.code), errorFrame.error.code);
      assert.ok(errorFrame.error.requestId);
      assert.ok(!oa.body.includes(REAL_SECRET));

      await until(async () => (await ledger(c.pool)).length === 1);
      assert.equal((await ledger(c.pool))[0]?.status, "error");

      const an = await anthropic(c, { stream: true });
      const events = parseSse(an.body).map((f) => f.event);
      assert.equal(events[events.length - 1], "error");
      assert.ok(!events.includes("message_stop"));
    });
  });
}

test("an idle provider stream is bounded by the vendor's configured timeout and ends with a timeout error", async () => {
  await withScenario(
    "streamHang",
    async (c) => {
      const started = Date.now();
      const res = await openAi(c, { stream: true });
      assert.ok(Date.now() - started < 2500, "must not hang");
      const frames = parseSse(res.body);
      const err = JSON.parse(frames[frames.length - 2]!.data) as { error: { code: string } };
      assert.equal(err.error.code, "TIMEOUT");
      await until(async () => (await ledger(c.pool)).length === 1);
      assert.equal((await ledger(c.pool))[0]?.error_category, "timeout");
    },
    { vendorOverrides: { timeoutMs: 150 } },
  );
});

// ------------------------------------------------------------ cancellation (real sockets)

test("client disconnect during a stream aborts the provider connection and records a cancelled ledger row", async () => {
  await withScenario("streamHang", async (c) => {
    await c.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (c.app.server.address() as { port: number }).port;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { ...bearer(c.rawKey), "content-type": "application/json" },
      body: JSON.stringify({ workloadId: c.workloadId, model: c.alias, stream: true, messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.ok(new TextDecoder().decode(first.value).includes("data:"));
    controller.abort();
    await reader.cancel().catch(() => undefined);

    await until(() => c.server.abortedCount() >= 1);
    await until(async () => (await ledger(c.pool)).length === 1);
    const row = (await ledger(c.pool))[0]!;
    assert.equal(row.status, "error");
    assert.equal(row.error_category, "cancelled");
  }, { vendorOverrides: { timeoutMs: 10_000 } });
});

test("client disconnect during a unary call aborts the provider request, and neither retries nor fallback run afterwards", async () => {
  const primary = await startMockProviderServer("hang");
  const fallback = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      const pv = await createVendor(app, primary.baseEndpoint, {
        automaticFallback: true, retryOnTimeout: true, retryOnRateLimit: true, retryOn5xx: true, retryMaxAttempts: 4, retryBackoffMs: 5, timeoutMs: 10_000,
      });
      const pm = await createModel(app, pv.id, { inhouseAlias: `p-${Math.random().toString(36).slice(2, 8)}` });
      await attachVendorToWorkload(app, pv.id, workload.id);
      await attachModelToWorkload(app, pm.id, workload.id);
      await createAccountAndCredential(app, pv.id);
      const pt = await createTier(app, workload.id, pv.id, pm.id, { tierNumber: 0 });
      const fv = await createVendor(app, fallback.baseEndpoint);
      const fm = await createModel(app, fv.id, { inhouseAlias: `f-${Math.random().toString(36).slice(2, 8)}` });
      await attachVendorToWorkload(app, fv.id, workload.id);
      await attachModelToWorkload(app, fm.id, workload.id);
      await createAccountAndCredential(app, fv.id);
      const ft = await createTier(app, workload.id, fv.id, fm.id, { tierNumber: 1 });
      await app.inject({ headers: ADMIN, method: "POST", url: `/v1/routing/workloads/${workload.id}/fallback-rules`, payload: { fromTierId: pt.id, toTierId: ft.id, conditionType: "on_error", priority: 0, enabled: true } });
      const { rawKey } = await createApiKey(app, [workload.id]);

      await app.listen({ port: 0, host: "127.0.0.1" });
      const port = (app.server.address() as { port: number }).port;
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { ...bearer(rawKey), "content-type": "application/json" },
        body: JSON.stringify({ workloadId: workload.id, model: pm.inhouseAlias, messages: [{ role: "user", content: "hi" }] }),
        signal: controller.signal,
      }).catch(() => null);
      await until(() => primary.requestCount() === 1);
      controller.abort();
      await pending;

      await until(() => primary.abortedCount() === 1);
      await until(async () => (await ledger(pool)).length === 1);
      await new Promise((r) => setTimeout(r, 150)); // room for a (wrong) retry or fallback to show up
      assert.equal(primary.requestCount(), 1, "no retry after cancellation");
      assert.equal(fallback.requestCount(), 0, "no fallback after cancellation");
      const row = (await ledger(pool))[0]!;
      assert.equal(row.error_category, "cancelled");
      assert.equal(row.attempt_count, 1);
    });
  } finally {
    await primary.close();
    await fallback.close();
  }
});

// ------------------------------------------------------------ tools (non-streaming) & Anthropic compatibility

const weather = { type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object", properties: { city: { type: "string" } } } } };

test("OpenAI tool call round trip: tools reach the provider in wire format; the response's tool_calls are normalized back out", async () => {
  await withScenario("toolCall", async (c) => {
    const res = await openAi(c, { tools: [weather], tool_choice: "auto" });
    assert.equal(res.statusCode, 200, res.body);
    const msg = res.json().choices[0];
    assert.equal(msg.finish_reason, "tool_calls");
    assert.equal(msg.message.content, null);
    assert.deepEqual(msg.message.tool_calls, [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }]);
    const sent = c.server.receivedBodies[0] as { tools: unknown[]; tool_choice: string };
    assert.equal(sent.tool_choice, "auto");
    assert.equal((sent.tools[0] as { function: { name: string } }).function.name, "get_weather");
    assert.ok(!res.body.includes(REAL_SECRET));
    const row = (await ledger(c.pool))[0]!;
    assert.deepEqual([row.input_tokens, row.output_tokens, row.total_tokens], [20, 6, 26]);
  });
});

test("Anthropic tool_use response, then a multi-turn continuation whose tool_result reaches the provider as a tool message", async () => {
  await withScenario("toolCall", async (c) => {
    const first = await anthropic(c, { tools: [{ name: "get_weather", description: "d", input_schema: { type: "object", properties: {} } }] });
    assert.equal(first.statusCode, 200, first.body);
    const body = first.json();
    assert.equal(body.stop_reason, "tool_use");
    assert.deepEqual(body.content, [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Oslo" } }]);
    assert.equal(body.usage.input_tokens, 20);

    const second = await anthropic(c, {
      tools: [{ name: "get_weather", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "weather in Oslo?" },
        { role: "assistant", content: body.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny, 21C" }] },
      ],
    });
    assert.equal(second.statusCode, 200, second.body);
    const sent = c.server.receivedBodies[1] as { messages: Array<Record<string, unknown>> };
    assert.deepEqual(sent.messages[1], {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }],
    });
    assert.deepEqual(sent.messages[2], { role: "tool", tool_call_id: "call_1", content: "sunny, 21C" });
  });
});

test("malformed or unsupported tool input is a 400 that never reaches the provider", async () => {
  await withScenario("success", async (c) => {
    const cases = [
      openAi(c, { messages: [{ role: "tool", tool_call_id: "ghost", content: "x" }] }),
      openAi(c, { tools: [{ type: "function", function: { name: "bad name!" } }] }),
      anthropic(c, { messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }),
      anthropic(c, { tools: [{ type: "computer_20250124", name: "computer" }] }),
    ];
    for (const res of await Promise.all(cases)) assert.equal(res.statusCode, 400, res.body);
    assert.equal(c.server.requestCount(), 0);
  });
});

test("Anthropic responses and errors use Anthropic's shapes: msg_ id, end_turn, numeric usage, {type:'error'} envelopes, request id", async () => {
  await withScenario("success", async (c) => {
    const ok = await anthropic(c);
    assert.equal(ok.statusCode, 200);
    const body = ok.json();
    assert.match(body.id, /^msg_/);
    assert.equal(body.type, "message");
    assert.equal(body.stop_reason, "end_turn");
    assert.equal(body.stop_sequence, null);
    assert.deepEqual(body.usage, { input_tokens: 12, output_tokens: 8 });

    const invalid = await c.app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": c.rawKey }, payload: { workloadId: c.workloadId, model: c.alias, messages: [{ role: "user", content: "hi" }] } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().type, "error");
    assert.equal(invalid.json().error.type, "invalid_request_error");
    assert.ok(invalid.json().request_id);

    const unauth = await c.app.inject({ method: "POST", url: "/v1/messages", payload: {} });
    assert.equal(unauth.statusCode, 401);
    assert.equal(unauth.json().error.type, "authentication_error");
    assert.equal(unauth.headers["x-request-id"], unauth.json().request_id);

    const denied = await c.app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": c.rawKey }, payload: { workloadId: "00000000-0000-0000-0000-000000000000", model: c.alias, max_tokens: 5, messages: [{ role: "user", content: "hi" }] } });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.type, "permission_error");
  });
  await withScenario("rateLimit", async (c) => {
    const res = await anthropic(c);
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error.type, "rate_limit_error");
    assert.ok(res.json().execution_id);
  });
});

// ------------------------------------------------------------ request ids

test("x-request-id: a safe caller id is honored end to end; oversized or unsafe ids are replaced with a fresh one", async () => {
  await withScenario("success", async (c) => {
    const good = await c.app.inject({ method: "POST", url: "/v1/chat/completions", headers: { ...bearer(c.rawKey), "x-request-id": "trace.abc:123_x-y" }, payload: { workloadId: c.workloadId, model: c.alias, messages: [{ role: "user", content: "hi" }] } });
    assert.equal(good.headers["x-request-id"], "trace.abc:123_x-y");
    assert.equal((await ledger(c.pool))[0]?.request_id, "trace.abc:123_x-y");

    for (const bad of ["x".repeat(129), "has space", "semi;colon", "quote\"", "<script>", "  ", ""]) {
      const res = await c.app.inject({ method: "POST", url: "/v1/chat/completions", headers: { ...bearer(c.rawKey), "x-request-id": bad }, payload: { workloadId: c.workloadId, model: c.alias, messages: [{ role: "user", content: "hi" }] } });
      const id = String(res.headers["x-request-id"]);
      assert.match(id, /^[0-9a-f-]{36}$/, `replaced id for ${JSON.stringify(bad)}`);
    }
    const rows = await ledger(c.pool);
    assert.ok(rows.every((r) => (r.request_id ?? "").length <= 128));
  });
});

// ------------------------------------------------------------ ledger / adapter robustness

test("provider success + failing ledger write: the client still gets its result, no database error leaks, and the recovery record is logged with the execution id", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedPool(async (pool, config) => {
      await truncateAll(pool, config.schema);
      const chunks: string[] = [];
      const app = await buildApp(loadConfig({ INHOUSE_API_ENV: "test", INHOUSE_ADMIN_TOKEN: TEST_ADMIN_TOKEN } as NodeJS.ProcessEnv), {
        pool,
        credentialVault: new CredentialVaultService(TEST_VAULT_KEY),
        loggerStream: new Writable({
          write(chunk: Buffer, _e, cb) {
            chunks.push(chunk.toString());
            cb();
          },
        }),
      });
      try {
        const workload = await createWorkload(pool);
        const { model } = await setUpEligibleTier(app, workload.id, server.baseEndpoint);
        const { rawKey } = await createApiKey(app, [workload.id]);
        await pool.query("ALTER TABLE usage_ledger RENAME TO usage_ledger_offline");
        try {
          const res = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: bearer(rawKey), payload: { workloadId: workload.id, model: model.inhouseAlias, messages: [{ role: "user", content: "hi" }] } });
          assert.equal(res.statusCode, 200, res.body);
          assert.equal(res.json().choices[0].message.content, "Hello from the mock provider.");
          assert.ok(!/usage_ledger|relation|SQL/i.test(res.body), "no database detail in the response");

          const logged = chunks.join("");
          const line = logged.split("\n").find((l) => l.includes("usage_ledger_write_failed"));
          assert.ok(line, "the failed write must be logged for reconciliation");
          const rec = JSON.parse(line!) as { execution_id: string; request_id: string; input_tokens: number; status: string; dbErrorCode: string };
          assert.equal(res.json().id, `chatcmpl-${rec.execution_id}`);
          assert.equal(rec.input_tokens, 12);
          assert.equal(rec.status, "success");
          assert.ok(!logged.includes(REAL_SECRET) && !logged.includes(rawKey));
        } finally {
          await pool.query("ALTER TABLE usage_ledger_offline RENAME TO usage_ledger");
        }
      } finally {
        await app.close();
      }
    });
  } finally {
    await server.close();
  }
});

test("an adapter that throws is normalized to a safe error with request/execution ids and an error ledger row — no stack, no internals", async () => {
  class ExplodingAdapter extends OpenAiCompatibleAdapter {
    override execute(): never {
      throw new Error(`boom at /srv/secret/path with ${REAL_SECRET}`);
    }
  }
  const registry = new AdapterRegistry();
  registry.register(new ExplodingAdapter() as ProviderAdapter);
  const server = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      const { model } = await setUpEligibleTier(app, workload.id, server.baseEndpoint);
      const { rawKey } = await createApiKey(app, [workload.id]);
      const res = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { ...bearer(rawKey), "x-request-id": "req-explode" }, payload: { workloadId: workload.id, model: model.inhouseAlias, messages: [{ role: "user", content: "hi" }] } });
      assert.equal(res.statusCode, 500);
      const err = res.json().error;
      assert.equal(err.code, "UNKNOWN");
      assert.equal(err.requestId, "req-explode");
      assert.ok(err.executionId);
      assert.ok(!/boom|secret|srv|at \w+/.test(res.body) && !res.body.includes(REAL_SECRET));
      const row = (await ledger(pool))[0]!;
      assert.equal(row.execution_id, err.executionId);
      assert.equal(row.error_category, "unknown");
      assert.equal(row.status, "error");
    }, { adapterRegistry: registry });
  } finally {
    await server.close();
  }
});

// ------------------------------------------------------- disabled entities & exhaustion

test("a disabled vendor is never executed: 503 no-eligible-candidate, zero provider requests, error ledger row", async () => {
  await withScenario("success", async (c) => {
    const vendors = (await c.app.inject({ headers: ADMIN, method: "GET", url: "/v1/vendors" })).json().vendors as Array<{ id: string }>;
    const patch = await c.app.inject({ headers: ADMIN, method: "PATCH", url: `/v1/vendors/${vendors[0]!.id}`, payload: { status: "disabled" } });
    assert.equal(patch.statusCode, 200, patch.body);
    const res = await openAi(c);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, "NO_ELIGIBLE_CANDIDATE");
    assert.equal(c.server.requestCount(), 0);
    assert.equal((await ledger(c.pool))[0]?.error_category, "no_eligible_candidate");
  });
});

test("a disabled credential is never used: the request fails as a configuration error with zero provider requests", async () => {
  await withScenario("success", async (c) => {
    const vendors = (await c.app.inject({ headers: ADMIN, method: "GET", url: "/v1/vendors" })).json().vendors as Array<{ id: string }>;
    const credentials = (await c.app.inject({ headers: ADMIN, method: "GET", url: `/v1/vendors/${vendors[0]!.id}/credentials` })).json().credentials as Array<{ id: string }>;
    const credentialId = credentials[0]!.id;
    const patch = await c.app.inject({ headers: ADMIN, method: "PATCH", url: `/v1/vendors/${vendors[0]!.id}/credentials/${credentialId}`, payload: { status: "disabled" } });
    assert.equal(patch.statusCode, 200, patch.body);
    const res = await openAi(c);
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error.code, "CONFIGURATION");
    assert.equal(c.server.requestCount(), 0);
    assert.ok(!res.body.includes(REAL_SECRET));
  });
});

test("a disabled model is never executed: no eligible candidate, zero provider requests", async () => {
  await withScenario("success", async (c) => {
    const models = (await c.app.inject({ headers: ADMIN, method: "GET", url: "/v1/models" })).json().models as Array<{ id: string }>;
    const patch = await c.app.inject({ headers: ADMIN, method: "PATCH", url: `/v1/models/${models[0]!.id}`, payload: { status: "disabled" } });
    assert.equal(patch.statusCode, 200, patch.body);
    const res = await openAi(c);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, "NO_ELIGIBLE_CANDIDATE");
    assert.equal(c.server.requestCount(), 0);
  });
});

test("fallback exhaustion: primary and fallback both fail, the chain stops there, and the final error plus both attempts are recorded", async () => {
  const a = await startMockProviderServer("serverError");
  const b = await startMockProviderServer("rateLimit");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      const av = await createVendor(app, a.baseEndpoint, { automaticFallback: true });
      const am = await createModel(app, av.id, { inhouseAlias: `a-${Math.random().toString(36).slice(2, 8)}` });
      await attachVendorToWorkload(app, av.id, workload.id);
      await attachModelToWorkload(app, am.id, workload.id);
      await createAccountAndCredential(app, av.id);
      const at = await createTier(app, workload.id, av.id, am.id, { tierNumber: 0 });
      const bv = await createVendor(app, b.baseEndpoint, { automaticFallback: true });
      const bm = await createModel(app, bv.id, { inhouseAlias: `b-${Math.random().toString(36).slice(2, 8)}` });
      await attachVendorToWorkload(app, bv.id, workload.id);
      await attachModelToWorkload(app, bm.id, workload.id);
      await createAccountAndCredential(app, bv.id);
      const bt = await createTier(app, workload.id, bv.id, bm.id, { tierNumber: 1 });
      await app.inject({ headers: ADMIN, method: "POST", url: `/v1/routing/workloads/${workload.id}/fallback-rules`, payload: { fromTierId: at.id, toTierId: bt.id, conditionType: "on_error", priority: 0, enabled: true } });
      const { rawKey } = await createApiKey(app, [workload.id]);

      const res = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: bearer(rawKey), payload: { workloadId: workload.id, model: am.inhouseAlias, messages: [{ role: "user", content: "hi" }] } });
      assert.equal(res.statusCode, 429, "the LAST failure (rate limit from the fallback) is what the client sees");
      assert.equal(res.json().error.code, "RATE_LIMIT");
      assert.equal(a.requestCount(), 1);
      assert.equal(b.requestCount(), 1);
      const row = (await ledger(pool))[0]!;
      assert.equal(row.attempt_count, 2);
      assert.equal(row.is_fallback, true);
      assert.equal(row.status, "error");
      assert.equal(row.error_category, "rate_limit");
    });
  } finally {
    await a.close();
    await b.close();
  }
});

// ------------------------------------------------------------ retry bounds & telemetry

for (const [maxAttempts, expectedRequests] of [[1, 1], [3, 3]] as const) {
  test(`retry is bounded by the configured max attempts: retryMaxAttempts=${maxAttempts} with an always-failing provider makes exactly ${expectedRequests} request(s)`, async () => {
    await withScenario(
      "serverError",
      async (c) => {
        const res = await openAi(c);
        assert.equal(res.statusCode, 502);
        assert.equal(c.server.requestCount(), expectedRequests);
        assert.equal((await ledger(c.pool))[0]?.attempt_count, expectedRequests);
      },
      { vendorOverrides: { retryOn5xx: true, retryMaxAttempts: maxAttempts, retryBackoffMs: 5 } },
    );
  });
}

test("authentication failures are not retried unless the vendor explicitly opts in", async () => {
  await withScenario(
    "unauthorized",
    async (c) => {
      await openAi(c);
      assert.equal(c.server.requestCount(), 1);
    },
    { vendorOverrides: { retryOn5xx: true, retryOnTimeout: true, retryOnRateLimit: true, retryMaxAttempts: 5, retryBackoffMs: 5 } },
  );
});

test("telemetry never carries secrets: GET /v1/usage exposes ids/counts/categories only — no provider secret, client key, hash, or prompt text", async () => {
  await withScenario("success", async (c) => {
    await openAi(c, { messages: [{ role: "user", content: "a-very-distinctive-prompt-text" }] });
    const usage = await c.app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` } });
    assert.equal(usage.statusCode, 200);
    const text = usage.body;
    assert.ok(!text.includes(REAL_SECRET));
    assert.ok(!text.includes(c.rawKey));
    assert.ok(!text.includes("a-very-distinctive-prompt-text"));
    assert.ok(!/key_hash|ciphertext|authorization/i.test(text));
    const entry = usage.json().usage[0];
    assert.ok(entry.executionId && entry.requestId);
    assert.equal(entry.providerCost, null, "costs are never fabricated");
  });
});
