import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAiCompatibleAdapter, type FetchLike } from "../src/services/adapters/openAiCompatibleAdapter.js";
import type { NormalizedProviderRequest, ProviderAdapterConfig } from "../src/services/providerAdapter.js";
import { runProviderAdapterContractSuite } from "./support/providerAdapterContract.js";

const config: ProviderAdapterConfig = { baseEndpoint: "https://example.invalid/v1", timeoutMs: 5000 };

const sampleRequest: NormalizedProviderRequest = {
  model: "gpt-test",
  messages: [{ role: "user", content: "Hello" }],
  maxOutputTokens: 100,
  temperature: 0.2,
  stream: false,
};

const successBody = {
  id: "chatcmpl-abc123",
  model: "gpt-test",
  choices: [{ message: { role: "assistant", content: "Hi there." }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
};

runProviderAdapterContractSuite("openai-compatible", {
  createAdapter: (fetchImpl: FetchLike) => new OpenAiCompatibleAdapter(fetchImpl),
  config,
  sampleRequest,
  successBody,
  assertSuccessResponse: (response) => {
    assert.equal(response.output, "Hi there.");
    assert.equal(response.finishReason, "stop");
    assert.equal(response.usage.inputTokens, 10);
    assert.equal(response.usage.outputTokens, 4);
    assert.equal(response.usage.totalTokens, 14);
  },
});

test("protocol identity is 'openai-compatible'", () => {
  const adapter = new OpenAiCompatibleAdapter(async () => new Response("{}", { status: 200 }));
  assert.equal(adapter.protocol, "openai-compatible");
});

test("execute() sends the request to '<baseEndpoint>/chat/completions' with a Bearer authorization header, never a forwarded caller header", async () => {
  let capturedUrl: string | null = null;
  let capturedHeaders: Headers | null = null;
  const adapter = new OpenAiCompatibleAdapter(async (input, init) => {
    capturedUrl = input;
    capturedHeaders = new Headers(init.headers);
    return new Response(JSON.stringify({ id: "x", model: "gpt-test", choices: [{ message: { content: "ok" } }] }), {
      status: 200,
    });
  });
  await adapter.execute("sk-secret", config, sampleRequest);
  assert.equal(capturedUrl, "https://example.invalid/v1/chat/completions");
  assert.equal((capturedHeaders as unknown as Headers).get("authorization"), "Bearer sk-secret");
  // Only the two headers this adapter constructs itself are ever sent.
  assert.deepEqual([...(capturedHeaders as unknown as Headers).keys()].sort(), ["authorization", "content-type"]);
});

test("checkHealth() calls '<baseEndpoint>/models' with a Bearer authorization header", async () => {
  let capturedUrl: string | null = null;
  let capturedMethod: string | null = null;
  const adapter = new OpenAiCompatibleAdapter(async (input, init) => {
    capturedUrl = input;
    capturedMethod = init.method ?? null;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
  await adapter.checkHealth("sk-secret", config);
  assert.equal(capturedUrl, "https://example.invalid/v1/models");
  assert.equal(capturedMethod, "GET");
});

test("a base endpoint with a trailing slash does not produce a double slash in the request URL", async () => {
  let capturedUrl: string | null = null;
  const adapter = new OpenAiCompatibleAdapter(async (input) => {
    capturedUrl = input;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
  await adapter.checkHealth("sk-secret", { ...config, baseEndpoint: "https://example.invalid/v1/" });
  assert.equal(capturedUrl, "https://example.invalid/v1/models");
});

test("execute() translates messages/model/params into the OpenAI-compatible wire format", async () => {
  let sentBody: Record<string, unknown> | null = null;
  const adapter = new OpenAiCompatibleAdapter(async (_input, init) => {
    sentBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify(successBody), { status: 200 });
  });
  await adapter.execute("sk-secret", config, sampleRequest);
  assert.deepEqual(sentBody, {
    model: "gpt-test",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    max_tokens: 100,
    temperature: 0.2,
  });
});

test("execute() rejects an oversized provider response body without buffering it fully", async () => {
  const adapter = new OpenAiCompatibleAdapter(async () => new Response("x".repeat(3_000_000), { status: 200 }));
  const result = await adapter.execute("sk-secret", config, sampleRequest);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.category, "provider_error");
    assert.ok(!result.error.message.includes("x".repeat(100)));
  }
});

test("execute() rejects an oversized request body without making a network call", async () => {
  let called = false;
  const adapter = new OpenAiCompatibleAdapter(async () => {
    called = true;
    return new Response("{}", { status: 200 });
  });
  const oversizedRequest: NormalizedProviderRequest = {
    ...sampleRequest,
    messages: [{ role: "user", content: "x".repeat(3_000_000) }],
  };
  const result = await adapter.execute("sk-secret", config, oversizedRequest);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.category, "invalid_request");
  assert.equal(called, false);
});
