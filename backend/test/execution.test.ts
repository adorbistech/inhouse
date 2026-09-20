import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config/index.js";
import { createAdminGuard } from "../src/plugins/adminAuth.js";
import { AnthropicStreamFormatter, OpenAiStreamFormatter, toAnthropicMessageResponse } from "../src/routes/executionFormatters.js";
import { extractBearerToken } from "../src/services/apiKeyAuthService.js";
import type { ExecutionSuccess } from "../src/services/execution/types.js";
import {
  boundedBackoffMs,
  conditionMatches,
  healthRank,
  isRetryableCategory,
  pickFallbackRule,
} from "../src/services/execution/failureClassification.js";
import { validateAnthropicMessagesInput, validateOpenAiChatCompletionInput } from "../src/validation/execution.js";
import type { VendorRow } from "../src/repositories/types.js";

const WORKLOAD_ID = "11111111-1111-1111-1111-111111111111";

function vendor(overrides: Partial<VendorRow> = {}): VendorRow {
  return {
    id: "vendor-1",
    slug: "test-vendor",
    display_name: "Test Vendor",
    vendor_type: "general_api",
    protocol: "openai-compatible",
    base_endpoint: "https://example.invalid",
    description: null,
    status: "enabled",
    billing_type: "metered",
    default_tier: 1,
    max_tier: 1,
    automatic_fallback: true,
    timeout_ms: 5000,
    retry_max_attempts: 3,
    retry_backoff_ms: 100,
    priority: 0,
    retry_on_timeout: false,
    retry_on_rate_limit: false,
    retry_on_5xx: false,
    retry_on_auth_failure: false,
    retry_on_invalid_response: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// --- extractBearerToken ---

test("extractBearerToken pulls the token out of a well-formed Authorization header", () => {
  assert.equal(extractBearerToken("Bearer ihk_abc123"), "ihk_abc123");
});

test("extractBearerToken returns null for a missing, malformed, or non-Bearer header", () => {
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken("ihk_abc123"), null);
  assert.equal(extractBearerToken("Basic dXNlcjpwYXNz"), null);
  assert.equal(extractBearerToken("Bearer "), null);
});

// --- OpenAI-compatible validation ---

test("validateOpenAiChatCompletionInput accepts a minimal valid body with a workloadId", () => {
  const parsed = validateOpenAiChatCompletionInput(
    { workloadId: WORKLOAD_ID, model: "my-alias", messages: [{ role: "user", content: "hi" }] },
    undefined,
  );
  assert.equal(parsed.workloadId, WORKLOAD_ID);
  assert.equal(parsed.modelAlias, "my-alias");
  assert.deepEqual(parsed.messages, [{ role: "user", content: "hi" }]);
  assert.equal(parsed.stream, false);
});

test("validateOpenAiChatCompletionInput accepts the workload id from the x-inhouse-workload-id header when absent from the body", () => {
  const parsed = validateOpenAiChatCompletionInput({ model: "my-alias", messages: [{ role: "user", content: "hi" }] }, WORKLOAD_ID);
  assert.equal(parsed.workloadId, WORKLOAD_ID);
});

test("validateOpenAiChatCompletionInput rejects a request with no workload id anywhere", () => {
  assert.throws(() => validateOpenAiChatCompletionInput({ model: "my-alias", messages: [{ role: "user", content: "hi" }] }, undefined));
});

test("validateOpenAiChatCompletionInput rejects the legacy functions API rather than silently ignoring it", () => {
  assert.throws(() =>
    validateOpenAiChatCompletionInput(
      { workloadId: WORKLOAD_ID, model: "my-alias", messages: [{ role: "user", content: "hi" }], functions: [] },
      undefined,
    ),
  );
});

test("validateOpenAiChatCompletionInput rejects an empty/missing messages array", () => {
  assert.throws(() => validateOpenAiChatCompletionInput({ workloadId: WORKLOAD_ID, model: "my-alias", messages: [] }, undefined));
});

test("validateOpenAiChatCompletionInput rejects an invalid message role", () => {
  assert.throws(() =>
    validateOpenAiChatCompletionInput(
      { workloadId: WORKLOAD_ID, model: "my-alias", messages: [{ role: "developer", content: "hi" }] },
      undefined,
    ),
  );
});

test("validateOpenAiChatCompletionInput surfaces stream:true through the parsed result rather than throwing", () => {
  const parsed = validateOpenAiChatCompletionInput(
    { workloadId: WORKLOAD_ID, model: "my-alias", messages: [{ role: "user", content: "hi" }], stream: true },
    undefined,
  );
  assert.equal(parsed.stream, true);
});

// --- Anthropic-compatible validation ---

test("validateAnthropicMessagesInput translates a top-level system field into a normalized system-role message", () => {
  const parsed = validateAnthropicMessagesInput(
    {
      workloadId: WORKLOAD_ID,
      model: "my-alias",
      system: "be helpful",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 256,
    },
    undefined,
  );
  assert.deepEqual(parsed.messages, [
    { role: "system", content: "be helpful" },
    { role: "user", content: "hi" },
  ]);
});

test("validateAnthropicMessagesInput accepts content-block-array message content", () => {
  const parsed = validateAnthropicMessagesInput(
    {
      workloadId: WORKLOAD_ID,
      model: "my-alias",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      max_tokens: 256,
    },
    undefined,
  );
  assert.equal(parsed.messages[0]?.content, "hello");
});

test("validateAnthropicMessagesInput requires max_tokens, unlike the OpenAI-compatible endpoint", () => {
  assert.throws(() =>
    validateAnthropicMessagesInput({ workloadId: WORKLOAD_ID, model: "my-alias", messages: [{ role: "user", content: "hi" }] }, undefined),
  );
});

test("validateAnthropicMessagesInput rejects a system-role entry inside messages (system is top-level only)", () => {
  assert.throws(() =>
    validateAnthropicMessagesInput(
      { workloadId: WORKLOAD_ID, model: "my-alias", messages: [{ role: "system", content: "hi" }], max_tokens: 10 },
      undefined,
    ),
  );
});

// --- Failure classification ---

test("isRetryableCategory consults the vendor's per-category retry flag, never a global default", () => {
  const v = vendor({ retry_on_timeout: true, retry_on_rate_limit: false });
  assert.equal(isRetryableCategory("timeout", v), true);
  assert.equal(isRetryableCategory("network", v), true);
  assert.equal(isRetryableCategory("rate_limit", v), false);
});

test("isRetryableCategory never retries invalid_request, model_not_found, configuration, or unknown regardless of vendor flags", () => {
  const v = vendor({
    retry_on_timeout: true,
    retry_on_rate_limit: true,
    retry_on_5xx: true,
    retry_on_auth_failure: true,
    retry_on_invalid_response: true,
  });
  assert.equal(isRetryableCategory("invalid_request", v), false);
  assert.equal(isRetryableCategory("model_not_found", v), false);
  assert.equal(isRetryableCategory("configuration", v), false);
  assert.equal(isRetryableCategory("unknown", v), false);
});

test("conditionMatches distinguishes on_invalid_response from on_5xx using safeErrorCode", () => {
  assert.equal(conditionMatches("on_invalid_response", "provider_error", null), true);
  assert.equal(conditionMatches("on_invalid_response", "provider_error", "502"), false);
  assert.equal(conditionMatches("on_5xx", "provider_error", "502"), true);
  assert.equal(conditionMatches("on_5xx", "provider_error", null), false);
});

test("conditionMatches: on_error matches every category, unconditionally", () => {
  assert.equal(conditionMatches("on_error", "authentication", null), true);
  assert.equal(conditionMatches("on_error", "unknown", null), true);
});

test("pickFallbackRule ignores disabled rules and non-matching conditions, and breaks ties by priority then id", () => {
  const rules = [
    { id: "rule-b", fromTierId: "t1", toTierId: "t2", conditionType: "on_timeout", conditionConfig: {}, priority: 5, enabled: true },
    { id: "rule-a", fromTierId: "t1", toTierId: "t3", conditionType: "on_timeout", conditionConfig: {}, priority: 5, enabled: true },
    { id: "rule-c", fromTierId: "t1", toTierId: "t4", conditionType: "on_timeout", conditionConfig: {}, priority: 9, enabled: false },
    { id: "rule-d", fromTierId: "t1", toTierId: "t5", conditionType: "on_rate_limit", conditionConfig: {}, priority: 10, enabled: true },
  ];
  const picked = pickFallbackRule(rules, "timeout", null);
  // rule-c has higher priority but is disabled; rule-d matches a different condition;
  // between rule-a and rule-b (tied priority), the lexicographically smaller id wins.
  assert.equal(picked?.id, "rule-a");
});

test("pickFallbackRule returns null when no enabled rule matches the failure", () => {
  const rules = [{ id: "rule-a", fromTierId: "t1", toTierId: "t2", conditionType: "on_rate_limit", conditionConfig: {}, priority: 1, enabled: true }];
  assert.equal(pickFallbackRule(rules, "timeout", null), null);
});

test("healthRank orders healthy < unknown < degraded < unhealthy", () => {
  assert.ok(healthRank("healthy") < healthRank("unknown"));
  assert.ok(healthRank("unknown") < healthRank("degraded"));
  assert.ok(healthRank("degraded") < healthRank("unhealthy"));
});

test("boundedBackoffMs never exceeds the hard ceiling, however large the vendor's configured backoff is", () => {
  assert.equal(boundedBackoffMs(50), 50);
  assert.equal(boundedBackoffMs(999_999), 2000);
  assert.equal(boundedBackoffMs(null), 250);
});

// --- Tool use: OpenAI shape ---

const openAiBase = { workloadId: WORKLOAD_ID, model: "my-alias" };
const weatherTool = { type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object", properties: {} } } };

test("OpenAI: tool definitions and tool_choice are accepted and normalized", () => {
  const parsed = validateOpenAiChatCompletionInput(
    { ...openAiBase, messages: [{ role: "user", content: "hi" }], tools: [weatherTool], tool_choice: { type: "function", function: { name: "get_weather" } } },
    undefined,
  );
  assert.deepEqual(parsed.tools, [{ name: "get_weather", description: "d", inputSchema: { type: "object", properties: {} } }]);
  assert.deepEqual(parsed.toolChoice, { name: "get_weather" });
});

test("OpenAI: a multi-turn tool conversation (assistant tool_calls then tool result) normalizes with linked ids", () => {
  const parsed = validateOpenAiChatCompletionInput(
    {
      ...openAiBase,
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }] },
        { role: "tool", tool_call_id: "c1", content: "sunny" },
      ],
      tools: [weatherTool],
    },
    undefined,
  );
  assert.deepEqual(parsed.messages[1], { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_weather", arguments: '{"city":"Oslo"}' }] });
  assert.deepEqual(parsed.messages[2], { role: "tool", toolCallId: "c1", content: "sunny" });
});

test("OpenAI: malformed tool data is rejected safely (dangling result, bad JSON arguments, bad tool name, non-text part)", () => {
  const bad: unknown[] = [
    [{ role: "user", content: "x" }, { role: "tool", tool_call_id: "nope", content: "r" }],
    [{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{not json" } }] }],
    [{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bad name!", arguments: "{}" } }] }],
    [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://x" } }] }],
    [{ role: "assistant", content: "" }],
  ];
  for (const messages of bad) {
    assert.throws(() => validateOpenAiChatCompletionInput({ ...openAiBase, messages }, undefined), /must|not supported|does not answer/i);
  }
});

// --- Tool use: Anthropic shape ---

const anthropicBase = { workloadId: WORKLOAD_ID, model: "my-alias", max_tokens: 100 };

test("Anthropic: tools/tool_choice normalize (any -> required) and cache_control annotations are ignored", () => {
  const parsed = validateAnthropicMessagesInput(
    {
      ...anthropicBase,
      system: [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
      tools: [{ name: "get_weather", description: "d", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "any" },
    },
    undefined,
  );
  assert.equal(parsed.toolChoice, "required");
  assert.deepEqual(parsed.messages[0], { role: "system", content: "be brief" });
  assert.equal(parsed.tools[0]?.name, "get_weather");
});

test("Anthropic: assistant tool_use and user tool_result blocks map to normalized tool calls/results, results first", () => {
  const parsed = validateAnthropicMessagesInput(
    {
      ...anthropicBase,
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Oslo" } }] },
        { role: "user", content: [{ type: "text", text: "thanks" }, { type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "sunny" }] }] },
      ],
    },
    undefined,
  );
  assert.deepEqual(parsed.messages, [
    { role: "user", content: "weather?" },
    { role: "assistant", content: "checking", toolCalls: [{ id: "tu_1", name: "get_weather", arguments: '{"city":"Oslo"}' }] },
    { role: "tool", toolCallId: "tu_1", content: "sunny" },
    { role: "user", content: "thanks" },
  ]);
});

test("Anthropic: unsupported blocks and tool types are refused, never silently dropped", () => {
  const cases: unknown[] = [
    { messages: [{ role: "user", content: [{ type: "image", source: {} }] }] },
    { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "ghost", content: "x" }] }] },
    { messages: [{ role: "user", content: "hi" }], tools: [{ type: "web_search_20250305", name: "web_search" }] },
    { messages: [{ role: "user", content: "hi" }], tools: [{ name: "ok", input_schema: "nope" }] },
  ];
  for (const extra of cases) {
    assert.throws(() => validateAnthropicMessagesInput({ ...anthropicBase, ...(extra as object) }, undefined));
  }
});

// --- Anthropic response mapping ---

function success(overrides: Partial<ExecutionSuccess> = {}): ExecutionSuccess {
  return {
    ok: true,
    executionId: "0a1b2c3d-0000-4000-8000-000000000001",
    requestId: "req-1",
    output: "hello",
    toolCalls: [],
    finishReason: "stop",
    model: { id: "m", inhouseAlias: "alias", providerModelId: "p" },
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    isFallback: false,
    attempts: [],
    providerRequestId: null,
    ...overrides,
  };
}

test("Anthropic response: msg_ id, explicit stop_reason mapping, numeric usage (0 on the wire when the provider reported none)", () => {
  const cases: Array<[ExecutionSuccess["finishReason"], string]> = [
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
    ["content_filter", "refusal"],
    ["other", "end_turn"],
    [null, "end_turn"],
  ];
  for (const [reason, expected] of cases) {
    const body = toAnthropicMessageResponse(success({ finishReason: reason }), "alias");
    assert.equal(body.stop_reason, expected);
    assert.match(body.id, /^msg_[0-9a-f]{32}$/);
    assert.equal(body.type, "message");
  }
  const noUsage = toAnthropicMessageResponse(success({ usage: { inputTokens: null, outputTokens: null, totalTokens: null } }), "alias");
  assert.deepEqual(noUsage.usage, { input_tokens: 0, output_tokens: 0 });
});

test("Anthropic response: tool calls become tool_use blocks with parsed input and no empty text block", () => {
  const body = toAnthropicMessageResponse(
    success({ output: "", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "f", arguments: '{"a":1}' }] }),
    "alias",
  );
  assert.deepEqual(body.content, [{ type: "tool_use", id: "c1", name: "f", input: { a: 1 } }]);
});

test("Anthropic stream: blocks are opened/closed in order, tool arguments stream as input_json_delta, terminates with message_stop", () => {
  const f = new AnthropicStreamFormatter("0a1b2c3d-0000-4000-8000-000000000001", "alias", "req-1");
  const out = [
    f.start(),
    f.format({ type: "text_delta", text: "Hi" }).text,
    f.format({ type: "tool_call_delta", index: 0, id: "c1", name: "f" }).text,
    f.format({ type: "tool_call_delta", index: 0, argumentsDelta: '{"a":' }).text,
    f.format({ type: "tool_call_delta", index: 0, argumentsDelta: "1}" }).text,
  ].join("");
  const end = f.format({ type: "finish", finishReason: "tool_calls", usage: { inputTokens: 9, outputTokens: 5, totalTokens: 14 }, providerRequestId: null, model: null });
  assert.ok(end.terminal);
  const all = out + end.text;
  const events = [...all.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
  assert.deepEqual(events, [
    "message_start",
    "content_block_start", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
    "message_delta", "message_stop",
  ]);
  assert.ok(all.includes('"stop_reason":"tool_use"'));
  assert.ok(all.includes('"output_tokens":5'));
});

test("Anthropic stream: a tool call that does not begin with id and name terminates with a safe error event", () => {
  const f = new AnthropicStreamFormatter("0a1b2c3d-0000-4000-8000-000000000001", "alias", "req-1");
  f.start();
  const chunk = f.format({ type: "tool_call_delta", index: 0, argumentsDelta: "{}" });
  assert.ok(chunk.terminal);
  assert.match(chunk.text, /^event: error/);
});

test("OpenAI stream: role chunk, deltas, finish chunk, optional usage chunk (only when the provider reported usage), [DONE]", () => {
  const f = new OpenAiStreamFormatter("0a1b2c3d-0000-4000-8000-000000000001", "alias", "req-1");
  assert.ok(f.start().includes('"role":"assistant"'));
  assert.ok(f.format({ type: "text_delta", text: "Hi" }).text.includes('"content":"Hi"'));
  const noUsage = f.format({ type: "finish", finishReason: "stop", usage: { inputTokens: null, outputTokens: null, totalTokens: null }, providerRequestId: null, model: null });
  assert.ok(noUsage.terminal && noUsage.text.endsWith("data: [DONE]\n\n"));
  assert.ok(!noUsage.text.includes('"usage"'));
  const withUsage = f.format({ type: "finish", finishReason: "length", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, providerRequestId: null, model: null });
  assert.ok(withUsage.text.includes('"finish_reason":"length"') && withUsage.text.includes('"total_tokens":3'));
});

// --- Admin guard & config ---

test("loadConfig: the admin token is optional in development (guard fails closed), required in production/staging, and must be long enough", () => {
  assert.equal(loadConfig({ INHOUSE_API_ENV: "development" } as NodeJS.ProcessEnv).adminToken, null);
  assert.throws(() => loadConfig({ INHOUSE_API_ENV: "production" } as NodeJS.ProcessEnv), /INHOUSE_ADMIN_TOKEN/);
  assert.throws(() => loadConfig({ INHOUSE_API_ENV: "staging" } as NodeJS.ProcessEnv), /INHOUSE_ADMIN_TOKEN/);
  assert.throws(() => loadConfig({ INHOUSE_API_ENV: "development", INHOUSE_ADMIN_TOKEN: "short" } as NodeJS.ProcessEnv), /at least 32/);
  const ok = "a".repeat(32);
  assert.equal(loadConfig({ INHOUSE_API_ENV: "production", INHOUSE_ADMIN_TOKEN: ok } as NodeJS.ProcessEnv).adminToken, ok);
});

test("createAdminGuard: no configured token -> 503 for everyone; wrong/missing -> 401; only the exact token passes", async () => {
  const token = "t".repeat(40);
  const guard = createAdminGuard(loadConfig({ INHOUSE_API_ENV: "development", INHOUSE_ADMIN_TOKEN: token } as NodeJS.ProcessEnv));
  const req = (authorization?: string) => ({ headers: authorization ? { authorization } : {} }) as never;
  await assert.doesNotReject(guard(req(`Bearer ${token}`)));
  for (const bad of [undefined, "Bearer nope", `Bearer ${token}x`, `Bearer ${token.slice(1)}`, token, "Bearer ihk_" + "0".repeat(64)]) {
    await assert.rejects(guard(req(bad)), (e: { statusCode?: number }) => e.statusCode === 401);
  }
  const closed = createAdminGuard(loadConfig({ INHOUSE_API_ENV: "development" } as NodeJS.ProcessEnv));
  await assert.rejects(closed(req(`Bearer ${token}`)), (e: { statusCode?: number; code?: string }) => e.statusCode === 503 && e.code === "ADMIN_AUTH_NOT_CONFIGURED");
});
