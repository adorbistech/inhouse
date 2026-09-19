import assert from "node:assert/strict";
import { test } from "node:test";
import { AdapterRegistry, createDefaultAdapterRegistry } from "../src/services/adapters/adapterRegistry.js";
import { OpenAiCompatibleAdapter } from "../src/services/adapters/openAiCompatibleAdapter.js";
import type {
  NormalizedProviderRequest,
  ProviderAdapter,
  ProviderAdapterConfig,
  ProviderExecutionResult,
  ProviderHealthCheckResult,
} from "../src/services/providerAdapter.js";

/** A minimal in-memory adapter, used only to exercise registry mechanics — never a real protocol. */
class StubAdapter implements ProviderAdapter {
  constructor(readonly protocol: string) {}
  async checkHealth(): Promise<ProviderHealthCheckResult> {
    return { status: "healthy", latencyMs: 1, errorCategory: null, safeErrorCode: null };
  }
  async execute(): Promise<ProviderExecutionResult> {
    return {
      ok: true,
      response: { providerRequestId: null, model: "x", output: "x", finishReason: null, usage: { inputTokens: null, outputTokens: null, totalTokens: null }, latencyMs: 1 },
    };
  }
}

test("get()/has() return undefined/false for an unregistered protocol — a vendor without an adapter is a normal state", () => {
  const registry = new AdapterRegistry();
  assert.equal(registry.has("some-unregistered-protocol"), false);
  assert.equal(registry.get("some-unregistered-protocol"), undefined);
});

test("register()/get()/has() round-trip for a registered protocol", () => {
  const registry = new AdapterRegistry();
  const adapter = new StubAdapter("stub-protocol");
  registry.register(adapter);
  assert.equal(registry.has("stub-protocol"), true);
  assert.equal(registry.get("stub-protocol"), adapter);
});

test("registering two adapters for the same protocol throws — one adapter per technical protocol", () => {
  const registry = new AdapterRegistry();
  registry.register(new StubAdapter("dup"));
  assert.throws(() => registry.register(new StubAdapter("dup")));
});

test("listSupportedProtocols() returns every registered protocol, sorted", () => {
  const registry = new AdapterRegistry();
  registry.register(new StubAdapter("zzz-protocol"));
  registry.register(new StubAdapter("aaa-protocol"));
  assert.deepEqual(registry.listSupportedProtocols(), ["aaa-protocol", "zzz-protocol"]);
});

test("multiple distinct business vendors sharing one protocol resolve to the exact same adapter instance", () => {
  const registry = new AdapterRegistry();
  const sharedAdapter = new StubAdapter("openai-compatible-like");
  registry.register(sharedAdapter);
  // "Vendor A" and "Vendor B" are represented only by the protocol string they'd carry
  // on their `vendors` row — the registry has no concept of a vendor at all.
  const forVendorA = registry.get("openai-compatible-like");
  const forVendorB = registry.get("openai-compatible-like");
  assert.equal(forVendorA, sharedAdapter);
  assert.equal(forVendorB, sharedAdapter);
});

test("createDefaultAdapterRegistry() registers the openai-compatible protocol adapter", () => {
  const registry = createDefaultAdapterRegistry();
  assert.equal(registry.has("openai-compatible"), true);
  assert.ok(registry.get("openai-compatible") instanceof OpenAiCompatibleAdapter);
});

test("createDefaultAdapterRegistry() does not claim support for an arbitrary business-provider-shaped protocol string", () => {
  const registry = createDefaultAdapterRegistry();
  for (const notAProtocol of ["openai", "anthropic", "z.ai", "alibaba", "cerebras", "custom_rest"]) {
    assert.equal(registry.has(notAProtocol), false);
  }
});

const config: ProviderAdapterConfig = { baseEndpoint: "https://example.invalid/v1", timeoutMs: 1000 };
const sampleRequest: NormalizedProviderRequest = {
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  maxOutputTokens: null,
  temperature: null,
  stream: false,
};

test("a vendor's adapter is looked up purely by its protocol string, never by vendor identity", async () => {
  const registry = new AdapterRegistry();
  registry.register(new StubAdapter("shared-protocol"));
  // Two different "vendors" (just protocol strings, since the registry has no vendor concept) using the same protocol:
  const adapterForVendorA = registry.get("shared-protocol");
  const adapterForVendorB = registry.get("shared-protocol");
  assert.ok(adapterForVendorA);
  assert.ok(adapterForVendorB);
  const resultA = await adapterForVendorA!.execute("secretA", config, sampleRequest);
  const resultB = await adapterForVendorB!.execute("secretB", config, sampleRequest);
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
});
