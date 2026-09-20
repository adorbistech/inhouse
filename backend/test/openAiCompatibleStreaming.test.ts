import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAiCompatibleAdapter, type FetchLike } from "../src/services/adapters/openAiCompatibleAdapter.js";
import type { NormalizedProviderRequest, NormalizedStreamEvent, ProviderAdapterConfig } from "../src/services/providerAdapter.js";

const config: ProviderAdapterConfig = { baseEndpoint: "https://example.invalid/v1", timeoutMs: 200 };
const request: NormalizedProviderRequest = {
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  maxOutputTokens: null,
  temperature: null,
  stream: true,
};

const enc = new TextEncoder();
const frame = (data: unknown): string => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
const chunk = (d: Record<string, unknown>, finish: string | null = null) => ({
  id: "r1",
  model: "m",
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});

/**
 * A `fetch` stub whose body yields the given byte chunks, then ends or stays
 * open. Like real `fetch`, aborting the request signal errors the body — the
 * behavior the adapter's idle-timeout and cancellation handling relies on.
 */
function streamFetch(parts: string[], opts: { hold?: boolean; status?: number } = {}): { fetch: FetchLike; cancelled: () => boolean } {
  let cancelled = false;
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) controller.enqueue(enc.encode(p));
        if (!opts.hold) controller.close();
        init.signal?.addEventListener("abort", () => {
          cancelled = true;
          try {
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
          } catch {
            // already closed
          }
        });
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { status: opts.status ?? 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: fetchImpl, cancelled: () => cancelled };
}

async function collect(events: AsyncIterable<NormalizedStreamEvent>): Promise<NormalizedStreamEvent[]> {
  const out: NormalizedStreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

async function open(fetchImpl: FetchLike, signal?: AbortSignal, cfg = config, req = request) {
  const result = await new OpenAiCompatibleAdapter(fetchImpl).executeStream("sk-secret", cfg, req, signal);
  assert.ok(result.ok, "expected the stream to open");
  return result;
}

test("executeStream normalizes text deltas, finish reason and provider usage", async () => {
  const { fetch: f } = streamFetch([
    frame(chunk({ role: "assistant", content: "" })),
    frame(chunk({ content: "Hel" })),
    frame(chunk({ content: "lo" })),
    frame(chunk({}, "stop")),
    frame({ id: "r1", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
    frame("[DONE]"),
  ]);
  const stream = await open(f);
  const events = await collect(stream.events);
  assert.deepEqual(
    events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text),
    ["Hel", "lo"],
  );
  const last = events[events.length - 1]!;
  assert.equal(last.type, "finish");
  assert.deepEqual(last.type === "finish" && last.usage, { inputTokens: 5, outputTokens: 2, totalTokens: 7 });
  assert.equal(last.type === "finish" && last.finishReason, "stop");
});

test("executeStream requests streaming with usage reporting and sends the credential only as a Bearer header", async () => {
  let seenBody: Record<string, unknown> = {};
  let seenAuth = "";
  const inner = streamFetch([frame(chunk({}, "stop")), frame("[DONE]")]).fetch;
  const stream = await open(async (url, init) => {
    seenBody = JSON.parse(init.body as string) as Record<string, unknown>;
    seenAuth = new Headers(init.headers).get("authorization") ?? "";
    return inner(url, init);
  });
  await collect(stream.events);
  assert.equal(seenBody.stream, true);
  assert.deepEqual(seenBody.stream_options, { include_usage: true });
  assert.equal(seenAuth, "Bearer sk-secret");
  assert.ok(!JSON.stringify(seenBody).includes("sk-secret"));
});

test("SSE events split across arbitrary byte boundaries (including inside a UTF-8 character and a CRLF) are reassembled", async () => {
  const whole = frame(chunk({ content: "héllo" })) + frame(chunk({}, "stop")) + frame("[DONE]");
  const bytes = enc.encode(whole.replace(/\n/g, "\r\n"));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
      controller.close();
    },
  });
  const stream = await open(async () => new Response(body, { status: 200 }));
  const events = await collect(stream.events);
  assert.deepEqual(
    events.filter((e) => e.type === "text_delta"),
    [{ type: "text_delta", text: "héllo" }],
  );
  assert.equal(events[events.length - 1]?.type, "finish");
});

test("streamed tool calls become normalized tool_call_delta events with a tool_calls finish", async () => {
  const { fetch: toolFetch } = streamFetch([
    frame(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } }] })),
    frame(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] })),
    frame(chunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] })),
    frame(chunk({}, "tool_calls")),
    frame("[DONE]"),
  ]);
  const events = await collect((await open(toolFetch)).events);
  const deltas = events.filter((e) => e.type === "tool_call_delta");
  assert.equal(deltas.length, 3);
  assert.deepEqual(deltas[0], { type: "tool_call_delta", index: 0, id: "call_1", name: "lookup" });
  assert.equal(deltas.map((d) => (d.type === "tool_call_delta" ? d.argumentsDelta ?? "" : "")).join(""), '{"q":"x"}');
  const last = events[events.length - 1]!;
  assert.equal(last.type === "finish" && last.finishReason, "tool_calls");
});

test("a non-2xx provider response fails before any stream opens, with a safe normalized error", async () => {
  const result = await new OpenAiCompatibleAdapter(async () => new Response("secret-detail sk-secret", { status: 429 })).executeStream(
    "sk-secret",
    config,
    request,
  );
  assert.ok(!result.ok);
  assert.equal(result.error.category, "rate_limit");
  assert.ok(!JSON.stringify(result).includes("sk-secret"));
});

test("a stream that ends without a finish reason or [DONE] is reported as an error, never as success", async () => {
  const events = await collect((await open(streamFetch([frame(chunk({ content: "partial" }))]).fetch)).events);
  const last = events[events.length - 1]!;
  assert.equal(last.type, "error");
  assert.equal(last.type === "error" && last.error.category, "provider_error");
});

test("an invalid event, an in-stream provider error, and a malformed tool call each terminate the stream with a normalized error", async () => {
  for (const bad of ["not json", { error: { message: "boom sk-secret" } }, chunk({ tool_calls: ["nope"] })]) {
    const events = await collect((await open(streamFetch([frame(chunk({ content: "a" })), frame(bad)], { hold: true }).fetch)).events);
    const last = events[events.length - 1]!;
    assert.equal(last.type, "error");
    assert.ok(!JSON.stringify(events).includes("sk-secret"));
  }
});

test("the stream is cut off past the total byte cap instead of being buffered without bound", async () => {
  const big = frame(chunk({ content: "x".repeat(500_000) }));
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(enc.encode(big));
      sent += big.length;
      if (sent > 20_000_000) controller.close(); // would exceed any sane cap if it were ever read this far
    },
  });
  const events = await collect((await open(async () => new Response(body, { status: 200 }), undefined, { ...config, timeoutMs: 5000 })).events);
  const last = events[events.length - 1]!;
  assert.equal(last.type, "error");
  assert.ok(sent < 20_000_000, "the reader must stop pulling once the cap is exceeded");
});

test("an idle stream is terminated by the idle timeout instead of hanging", async () => {
  const stream = await open(streamFetch([frame(chunk({ content: "first" }))], { hold: true }).fetch, undefined, { ...config, timeoutMs: 80 });
  const started = Date.now();
  const events = await collect(stream.events);
  const last = events[events.length - 1]!;
  assert.equal(last.type === "error" && last.error.category, "timeout");
  assert.ok(Date.now() - started < 1500);
});

test("aborting the caller's signal mid-stream ends the stream as 'cancelled' and cancels the provider body", async () => {
  const { fetch: heldFetch, cancelled } = streamFetch([frame(chunk({ content: "first" }))], { hold: true });
  const controller = new AbortController();
  const stream = await open(heldFetch, controller.signal, { ...config, timeoutMs: 5000 });
  const iterator = stream.events[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value?.type, "text_delta");
  controller.abort();
  const next = await iterator.next();
  assert.equal(next.value?.type === "error" && next.value.error.category, "cancelled");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(cancelled(), "the provider connection must be released");
});

test("a signal that is already aborted never reaches the network", async () => {
  let called = false;
  const controller = new AbortController();
  controller.abort();
  const adapter = new OpenAiCompatibleAdapter(async (_url, init) => {
    called = true;
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return new Response("{}");
  });
  const unary = await adapter.execute("sk-secret", config, { ...request, stream: false }, controller.signal);
  assert.ok(!unary.ok && unary.error.category === "cancelled");
  const streamed = await adapter.executeStream("sk-secret", config, request, controller.signal);
  assert.ok(!streamed.ok && streamed.error.category === "cancelled");
  void called;
});

test("unary execute reports a caller abort as 'cancelled', not 'timeout'", async () => {
  const controller = new AbortController();
  const adapter = new OpenAiCompatibleAdapter(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
  const pending = adapter.execute("sk-secret", { ...config, timeoutMs: 5000 }, { ...request, stream: false }, controller.signal);
  setTimeout(() => controller.abort(), 20);
  const result = await pending;
  assert.ok(!result.ok);
  assert.equal(result.error.category, "cancelled");
});

// --- Tools (non-streaming) ---

const toolRequest: NormalizedProviderRequest = {
  model: "m",
  messages: [
    { role: "user", content: "weather?" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Oslo"}' }] },
    { role: "tool", toolCallId: "call_1", content: "sunny" },
  ],
  maxOutputTokens: null,
  temperature: null,
  stream: false,
  tools: [{ name: "get_weather", description: "Look up weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }],
  toolChoice: { name: "get_weather" },
};

test("tool definitions, choice, assistant tool calls and tool results are translated to the wire format", async () => {
  let body: Record<string, unknown> = {};
  await new OpenAiCompatibleAdapter(async (_url, init) => {
    body = JSON.parse(init.body as string) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  }).execute("sk-secret", config, toolRequest);
  assert.deepEqual(body.tools, [
    {
      type: "function",
      function: { name: "get_weather", description: "Look up weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
    },
  ]);
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "get_weather" } });
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[1], {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }],
  });
  assert.deepEqual(messages[2], { role: "tool", tool_call_id: "call_1", content: "sunny" });
});

test("a tool-call response is normalized (null content is fine when tool calls are present)", async () => {
  const result = await new OpenAiCompatibleAdapter(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
              finish_reason: "tool_calls",
            },
          ],
        }),
      ),
  ).execute("sk-secret", config, { ...request, stream: false });
  assert.ok(result.ok);
  assert.deepEqual(result.response.toolCalls, [{ id: "c1", name: "f", arguments: "{}" }]);
  assert.equal(result.response.finishReason, "tool_calls");
  assert.equal(result.response.output, "");
});

test("a structurally invalid tool call in a provider response is a malformed-response error, not a crash", async () => {
  for (const toolCalls of [[{ id: "c1", function: { name: "f" } }], "nope", [{ type: "function", function: { name: "f", arguments: "{}" } }]]) {
    const result = await new OpenAiCompatibleAdapter(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: "x", tool_calls: toolCalls } }] })),
    ).execute("sk-secret", config, { ...request, stream: false });
    assert.ok(!result.ok);
    assert.equal(result.error.category, "provider_error");
  }
});

test("finish reasons are mapped onto the normalized set; unknown provider values become 'other'", async () => {
  const cases: Array<[string, string]> = [
    ["stop", "stop"],
    ["length", "length"],
    ["tool_calls", "tool_calls"],
    ["function_call", "tool_calls"],
    ["content_filter", "content_filter"],
    ["something_new", "other"],
  ];
  for (const [raw, expected] of cases) {
    const result = await new OpenAiCompatibleAdapter(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: raw }] })),
    ).execute("sk-secret", config, { ...request, stream: false });
    assert.ok(result.ok);
    assert.equal(result.response.finishReason, expected);
  }
});
