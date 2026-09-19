import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  NormalizedProviderRequest,
  ProviderAdapter,
  ProviderAdapterConfig,
} from "../../src/services/providerAdapter.js";
import type { FetchLike } from "../../src/services/adapters/openAiCompatibleAdapter.js";

/**
 * A reusable contract suite every HTTP-transport `ProviderAdapter`
 * implementation must satisfy — request translation, response
 * normalization, error normalization, timeout behavior, health behavior,
 * and secret non-leakage (see docs/PROVIDER_ADAPTERS.md, "Testing"). A new
 * protocol adapter is expected to pass this suite via its own thin test
 * file (see `openAiCompatibleAdapter.test.ts`) rather than duplicating
 * these assertions by hand.
 *
 * Deliberately transport-stub-based, not a real network call to any real
 * provider (see docs/PROVIDER_ADAPTERS.md, "Real Provider Testing") — every
 * scenario here is a synthetic, deterministic `FetchLike` stub.
 */
export interface ProviderAdapterContractHarness {
  /** Constructs a fresh adapter instance wired to the given transport stub. */
  createAdapter(fetchImpl: FetchLike): ProviderAdapter;
  config: ProviderAdapterConfig;
  sampleRequest: NormalizedProviderRequest;
  /** A well-formed *provider* success body for a generation request (protocol wire format, not the normalized shape). */
  successBody: unknown;
  /** Asserts protocol-specific fields on a successful normalized response (e.g. `output`, `usage`). */
  assertSuccessResponse(response: {
    output: string;
    finishReason: string | null;
    usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  }): void;
  /** A well-formed *provider* success body for the health check's minimal call, if distinct from a 200 with no body requirement. */
  healthSuccessBody?: unknown;
}

const SECRET = "sk-test-secret-value-should-never-leak-anywhere";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

function abortingFetch(): FetchLike {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init.signal;
      if (!signal) return;
      const reject_ = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (signal.aborted) {
        reject_();
        return;
      }
      signal.addEventListener("abort", reject_);
    });
}

function throwingFetch(code: string): FetchLike {
  return () => Promise.reject(Object.assign(new Error(`connect ${code}`), { code }));
}

export function runProviderAdapterContractSuite(name: string, harness: ProviderAdapterContractHarness): void {
  test(`[contract:${name}] execute() translates the request and normalizes a well-formed success response`, async () => {
    const adapter = harness.createAdapter(async () => jsonResponse(200, harness.successBody));
    const result = await adapter.execute(SECRET, harness.config, harness.sampleRequest);
    assert.equal(result.ok, true);
    if (result.ok) {
      harness.assertSuccessResponse(result.response);
      assert.equal(typeof result.response.latencyMs, "number");
    }
  });

  const statusCases: { status: number; expectedCategory: string }[] = [
    { status: 400, expectedCategory: "invalid_request" },
    { status: 401, expectedCategory: "authentication" },
    { status: 403, expectedCategory: "authorization" },
    { status: 404, expectedCategory: "model_not_found" },
    { status: 429, expectedCategory: "rate_limit" },
    { status: 500, expectedCategory: "provider_error" },
    { status: 503, expectedCategory: "unavailable" },
  ];

  for (const { status, expectedCategory } of statusCases) {
    test(`[contract:${name}] execute() maps HTTP ${status} to "${expectedCategory}" without leaking the response body`, async () => {
      const adapter = harness.createAdapter(async () => textResponse(status, "raw provider error body, never surfaced"));
      const result = await adapter.execute(SECRET, harness.config, harness.sampleRequest);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.category, expectedCategory);
        assert.equal(result.error.safeErrorCode, String(status));
        assert.ok(!result.error.message.includes("raw provider error body"));
      }
    });
  }

  test(`[contract:${name}] execute() maps malformed JSON to "provider_error"`, async () => {
    const adapter = harness.createAdapter(async () => textResponse(200, "not json"));
    const result = await adapter.execute(SECRET, harness.config, harness.sampleRequest);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "provider_error");
  });

  test(`[contract:${name}] execute() maps a response missing required fields to "provider_error"`, async () => {
    const adapter = harness.createAdapter(async () => jsonResponse(200, { unexpected: "shape" }));
    const result = await adapter.execute(SECRET, harness.config, harness.sampleRequest);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "provider_error");
  });

  test(`[contract:${name}] execute() maps a network failure to "network" with a safe, short code`, async () => {
    const adapter = harness.createAdapter(throwingFetch("ECONNREFUSED"));
    const result = await adapter.execute(SECRET, harness.config, harness.sampleRequest);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.category, "network");
      assert.equal(result.error.safeErrorCode, "ECONNREFUSED");
    }
  });

  test(`[contract:${name}] execute() maps an aborted/timed-out request to "timeout"`, async () => {
    const adapter = harness.createAdapter(abortingFetch());
    const result = await adapter.execute(SECRET, { ...harness.config, timeoutMs: 20 }, harness.sampleRequest);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.category, "timeout");
      assert.equal(result.error.safeErrorCode, "ETIMEDOUT");
    }
  });

  test(`[contract:${name}] execute() never leaks the secret in an error message or safe error code, across every failure mode`, async () => {
    const scenarios: FetchLike[] = [
      async () => textResponse(401, "unauthorized"),
      async () => textResponse(500, "server error"),
      throwingFetch("ECONNRESET"),
      abortingFetch(),
    ];
    for (const fetchImpl of scenarios) {
      const adapter = harness.createAdapter(fetchImpl);
      const result = await adapter.execute(SECRET, { ...harness.config, timeoutMs: 20 }, harness.sampleRequest);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(!result.error.message.includes(SECRET));
        assert.ok(!(result.error.safeErrorCode ?? "").includes(SECRET));
      }
    }
  });

  test(`[contract:${name}] execute() never sends the secret in the request body, only as an outbound credential`, async () => {
    let capturedBody: string | null = null;
    const adapter = harness.createAdapter(async (_input, init) => {
      capturedBody = typeof init.body === "string" ? init.body : null;
      return jsonResponse(200, harness.successBody);
    });
    await adapter.execute(SECRET, harness.config, harness.sampleRequest);
    assert.ok(capturedBody !== null);
    assert.ok(!(capturedBody as string).includes(SECRET));
  });

  test(`[contract:${name}] checkHealth() reports "healthy" on a 2xx response`, async () => {
    const adapter = harness.createAdapter(async () => jsonResponse(200, harness.healthSuccessBody ?? { data: [] }));
    const result = await adapter.checkHealth(SECRET, harness.config);
    assert.equal(result.status, "healthy");
    assert.equal(result.errorCategory, null);
    assert.equal(typeof result.latencyMs, "number");
  });

  test(`[contract:${name}] checkHealth() reports "unhealthy" with a safe, narrow error category on failure`, async () => {
    const adapter = harness.createAdapter(async () => textResponse(401, "raw provider body"));
    const result = await adapter.checkHealth(SECRET, harness.config);
    assert.equal(result.status, "unhealthy");
    assert.equal(result.errorCategory, "authentication");
    assert.equal(result.safeErrorCode, "401");
  });

  test(`[contract:${name}] checkHealth() respects timeoutMs and reports "timeout"`, async () => {
    const adapter = harness.createAdapter(abortingFetch());
    const result = await adapter.checkHealth(SECRET, { ...harness.config, timeoutMs: 20 });
    assert.equal(result.status, "unhealthy");
    assert.equal(result.errorCategory, "timeout");
    assert.equal(result.safeErrorCode, "ETIMEDOUT");
  });

  test(`[contract:${name}] checkHealth() never leaks the secret in its result`, async () => {
    const adapter = harness.createAdapter(async () => textResponse(500, "server error"));
    const result = await adapter.checkHealth(SECRET, harness.config);
    assert.ok(!(result.safeErrorCode ?? "").includes(SECRET));
  });
}
