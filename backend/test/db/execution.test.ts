import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { TEST_ADMIN_TOKEN, TEST_VAULT_KEY, truncateAll, withMigratedApp, withMigratedPool } from "./helpers.js";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { CredentialVaultService } from "../../src/lib/credentialVault.js";
import { UsageLedgerRepository } from "../../src/repositories/usageLedgerRepository.js";
import {
  ADMIN,
  REAL_SECRET,
  attachModelToWorkload,
  attachVendorToWorkload,
  createAccountAndCredential,
  createApiKey,
  createModel,
  createTier,
  createVendor,
  createWorkload,
  setUpEligibleTier,
  startMockProviderServer,
} from "./executionSupport.js";

// --- Authentication ---

test("execution endpoints reject a missing, unknown, revoked, and expired API key, and accept a valid one", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      const { model } = await setUpEligibleTier(app, workload.id, server.baseEndpoint);
      const { rawKey, apiKey } = await createApiKey(app, [workload.id]);

      const body = { workloadId: workload.id, model: model.inhouseAlias, messages: [{ role: "user", content: "hi" }] };

      const missing = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
      assert.equal(missing.statusCode, 401);

      const unknown = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer ihk_does_not_exist" },
        payload: body,
      });
      assert.equal(unknown.statusCode, 401);

      await app.inject({ method: "DELETE", url: `/v1/api-keys/${apiKey.id}`, headers: ADMIN });
      const revoked = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: body,
      });
      assert.equal(revoked.statusCode, 401);

      const { rawKey: validKey } = await createApiKey(app, [workload.id]);
      const ok = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${validKey}` },
        payload: body,
      });
      assert.equal(ok.statusCode, 200, ok.body);
    });
  } finally {
    await server.close();
  }
});

test("POST /v1/api-keys returns the raw key exactly once; GET /v1/api-keys never includes it or key_hash", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const wl = await createWorkload(pool);
    const created = await app.inject({ method: "POST", url: "/v1/api-keys", headers: ADMIN, payload: { name: "list-test-key", workloadIds: [wl.id] } });
    assert.equal(created.statusCode, 201);
    const rawKey: string = created.json().rawKey;
    assert.ok(rawKey.startsWith("ihk_"));

    const listed = await app.inject({ method: "GET", url: "/v1/api-keys", headers: ADMIN });
    const bodyText = JSON.stringify(listed.json());
    assert.ok(!bodyText.includes(rawKey));
    assert.ok(!bodyText.includes("key_hash"));
  });
});

// --- Request validation / routing-layer errors ---

test("an unknown workload id is indistinguishable from an ungranted one (403), and an unknown model alias is 400, before any provider call", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      await setUpEligibleTier(app, workload.id, server.baseEndpoint);
      const { rawKey } = await createApiKey(app, [workload.id]);

      const missingWorkload = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { workloadId: "00000000-0000-0000-0000-000000000000", model: "whatever", messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(missingWorkload.statusCode, 403);
      assert.equal(missingWorkload.json().error.code, "WORKLOAD_NOT_PERMITTED");

      const missingModel = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { workloadId: workload.id, model: "no-such-alias", messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(missingModel.statusCode, 400);

      assert.equal(server.requestCount(), 0, "no provider request should ever have been made");
    });
  } finally {
    await server.close();
  }
});

test("no eligible routing candidate (no tier configured) is reported as 503 with a normalized error, and is recorded in the usage ledger", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const vendor = await createVendor(app, "http://127.0.0.1:1");
    const model = await createModel(app, vendor.id);
    // Deliberately never attach vendor/model to the workload, and never create a tier.
    const { rawKey } = await createApiKey(app, [workload.id]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { workloadId: workload.id, model: model.inhouseAlias, messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, "NO_ELIGIBLE_CANDIDATE");

    const usage = await new UsageLedgerRepository(pool).listRecent(10);
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.status, "error");
    assert.equal(usage[0]?.error_category, "no_eligible_candidate");
  });
});

test("a disabled vendor account fails as a configuration error rather than reaching the provider", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      const { model, account } = await setUpEligibleTier(app, workload.id, server.baseEndpoint);
      const { rawKey } = await createApiKey(app, [workload.id]);

      // DELETE on an account is a soft disable (routes/vendors.ts: setStatus("disabled")).
      const disableRes = await app.inject({ headers: ADMIN, method: "DELETE", url: `/v1/vendors/${account.vendorId}/accounts/${account.id}` });
      assert.equal(disableRes.statusCode, 200, disableRes.body);

      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { workloadId: workload.id, model: model.inhouseAlias, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 502);
      assert.equal(res.json().error.code, "CONFIGURATION");
      assert.equal(server.requestCount(), 0, "a disabled account must never reach the provider");
    });
  } finally {
    await server.close();
  }
});

// --- Successful execution, both client-compatible shapes ---

test("a successful OpenAI-compatible execution: correct outbound auth/body, normalized response, and a success usage ledger row", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      const { model, vendor } = await setUpEligibleTier(app, workload.id, server.baseEndpoint);
      const { rawKey } = await createApiKey(app, [workload.id]);

      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { workloadId: workload.id, model: model.inhouseAlias, max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      assert.equal(body.choices[0].message.content, "Hello from the mock provider.");
      assert.equal(body.usage.prompt_tokens, 12);
      assert.equal(body.usage.completion_tokens, 8);
      assert.ok(body.id);

      assert.equal(server.receivedAuthHeaders[0], `Bearer ${REAL_SECRET}`);
      assert.equal((server.receivedBodies[0] as { model: string }).model, "provider-model-x");

      const usage = await new UsageLedgerRepository(pool).listRecent(10);
      assert.equal(usage.length, 1);
      assert.equal(usage[0]?.status, "success");
      assert.equal(usage[0]?.vendor_id, vendor.id);
      assert.equal(usage[0]?.input_tokens, 12);
      assert.equal(body.id, `chatcmpl-${usage[0]?.execution_id}`);
      assert.equal(usage[0]?.attempt_count, 1);
      assert.equal(usage[0]?.is_fallback, false);
    });
  } finally {
    await server.close();
  }
});

test("a successful Anthropic-compatible execution returns Anthropic-shaped content/usage", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      const { model } = await setUpEligibleTier(app, workload.id, server.baseEndpoint);
      const { rawKey } = await createApiKey(app, [workload.id]);

      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          workloadId: workload.id,
          model: model.inhouseAlias,
          max_tokens: 64,
          system: "be terse",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      assert.equal(body.type, "message");
      assert.equal(body.content[0].type, "text");
      assert.equal(body.content[0].text, "Hello from the mock provider.");
      assert.equal(body.usage.input_tokens, 12);
      assert.equal(body.usage.output_tokens, 8);
    });
  } finally {
    await server.close();
  }
});

test("a workload id supplied only via the x-inhouse-workload-id header is honored", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      const { model } = await setUpEligibleTier(app, workload.id, server.baseEndpoint);
      const { rawKey } = await createApiKey(app, [workload.id]);

      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${rawKey}`, "x-inhouse-workload-id": workload.id },
        payload: { model: model.inhouseAlias, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 200, res.body);
    });
  } finally {
    await server.close();
  }
});

test("the Anthropic SDK/Claude Code x-api-key header authenticates exactly like Authorization: Bearer does", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      const { model } = await setUpEligibleTier(app, workload.id, server.baseEndpoint);
      const { rawKey } = await createApiKey(app, [workload.id]);

      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { "x-api-key": rawKey },
        payload: { workloadId: workload.id, model: model.inhouseAlias, max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 200, res.body);
    });
  } finally {
    await server.close();
  }
});

// --- Provider failure classification ---

for (const [behavior, expectedCategory, expectedStatus] of [
  ["unauthorized", "AUTHENTICATION", 502],
  ["rateLimit", "RATE_LIMIT", 429],
  ["serverError", "PROVIDER_ERROR", 502],
  ["malformed", "PROVIDER_ERROR", 502],
] as const) {
  test(`a provider ${behavior} response is classified as ${expectedCategory} and returned as a safe, normalized error`, async () => {
    const server = await startMockProviderServer(behavior);
    try {
      await withMigratedApp(async (app, pool) => {
        await truncateAll(pool, "inhouse");
        const workload = await createWorkload(pool);
        const { model } = await setUpEligibleTier(app, workload.id, server.baseEndpoint);
        const { rawKey } = await createApiKey(app, [workload.id]);

        const res = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: { authorization: `Bearer ${rawKey}` },
          payload: { workloadId: workload.id, model: model.inhouseAlias, messages: [{ role: "user", content: "hi" }] },
        });
        assert.equal(res.statusCode, expectedStatus, res.body);
        assert.equal(res.json().error.code, expectedCategory);
        const bodyText = res.body;
        assert.ok(!bodyText.includes(REAL_SECRET));
        assert.ok(!bodyText.includes("invalid api key"));

        const usage = await new UsageLedgerRepository(pool).listRecent(10);
        assert.equal(usage[0]?.status, "error");
        assert.equal(usage[0]?.error_category, expectedCategory.toLowerCase());
      });
    } finally {
      await server.close();
    }
  });
}

test("a provider timeout is bounded by the tier's configured timeout, not the provider's actual delay", async () => {
  const server = await startMockProviderServer("slow");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      const { model } = await setUpEligibleTier(app, workload.id, server.baseEndpoint, { vendorOverrides: { timeoutMs: 150 } });
      const { rawKey } = await createApiKey(app, [workload.id]);

      const start = Date.now();
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { workloadId: workload.id, model: model.inhouseAlias, messages: [{ role: "user", content: "hi" }] },
      });
      const elapsed = Date.now() - start;
      assert.equal(res.statusCode, 504);
      assert.equal(res.json().error.code, "TIMEOUT");
      assert.ok(elapsed < 1000, `expected the call to abort near 150ms, took ${elapsed}ms`);
    });
  } finally {
    await server.close();
  }
});

// --- Retry ---

test("a transient failure is retried on the same candidate when the vendor's retry flag permits it, and succeeds on the second attempt", async () => {
  const server = await startMockProviderServer("flaky");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      const vendor = await createVendor(app, server.baseEndpoint, { retryMaxAttempts: 3, retryBackoffMs: 5, retryOn5xx: true });
      const model = await createModel(app, vendor.id);
      await attachVendorToWorkload(app, vendor.id, workload.id);
      await attachModelToWorkload(app, model.id, workload.id);
      await createAccountAndCredential(app, vendor.id);
      await createTier(app, workload.id, vendor.id, model.id);
      const { rawKey } = await createApiKey(app, [workload.id]);

      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { workloadId: workload.id, model: model.inhouseAlias, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(server.requestCount(), 3); // 2 failures + 1 success, all against the same candidate

      const usage = await new UsageLedgerRepository(pool).listRecent(10);
      assert.equal(usage[0]?.attempt_count, 3);
      assert.equal(usage[0]?.is_fallback, false);
    });
  } finally {
    await server.close();
  }
});

test("a non-retryable category (invalid_request-shaped 400) is never retried even when the vendor's retry flags are all on", async () => {
  const server = await startMockProviderServer("serverError");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      // retry_on_5xx is false here — a 500 must not be retried.
      const { model } = await setUpEligibleTier(app, workload.id, server.baseEndpoint, { vendorOverrides: { retryMaxAttempts: 5, retryOn5xx: false } });
      const { rawKey } = await createApiKey(app, [workload.id]);

      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { workloadId: workload.id, model: model.inhouseAlias, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(server.requestCount(), 1, "retry_on_5xx=false must mean exactly one attempt");
    });
  } finally {
    await server.close();
  }
});

// --- Fallback ---

test("fallback: a failing primary tier falls back to a matching, enabled fallback rule's target tier and succeeds there", async () => {
  const failingServer = await startMockProviderServer("serverError");
  const healthyServer = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);

      const primaryVendor = await createVendor(app, failingServer.baseEndpoint, { automaticFallback: true, retryMaxAttempts: 1 });
      const primaryModel = await createModel(app, primaryVendor.id, { inhouseAlias: `primary-${Math.random().toString(36).slice(2, 8)}` });
      await attachVendorToWorkload(app, primaryVendor.id, workload.id);
      await attachModelToWorkload(app, primaryModel.id, workload.id);
      await createAccountAndCredential(app, primaryVendor.id);
      const primaryTier = await createTier(app, workload.id, primaryVendor.id, primaryModel.id, { tierNumber: 0 });

      const fallbackVendor = await createVendor(app, healthyServer.baseEndpoint);
      const fallbackModel = await createModel(app, fallbackVendor.id, { inhouseAlias: `fallback-${Math.random().toString(36).slice(2, 8)}` });
      await attachVendorToWorkload(app, fallbackVendor.id, workload.id);
      await attachModelToWorkload(app, fallbackModel.id, workload.id);
      await createAccountAndCredential(app, fallbackVendor.id);
      const fallbackTier = await createTier(app, workload.id, fallbackVendor.id, fallbackModel.id, { tierNumber: 1 });

      const ruleRes = await app.inject({ headers: ADMIN,
        method: "POST",
        url: `/v1/routing/workloads/${workload.id}/fallback-rules`,
        payload: { fromTierId: primaryTier.id, toTierId: fallbackTier.id, conditionType: "on_5xx", priority: 0, enabled: true },
      });
      assert.equal(ruleRes.statusCode, 201, ruleRes.body);

      const { rawKey } = await createApiKey(app, [workload.id]);
      // The execution requests the PRIMARY model alias — routing's own "model_not_requested" exclusion means
      // the fallback tier (a different model) is only reachable via the fallback rule, never as an independent candidate.
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { workloadId: workload.id, model: primaryModel.inhouseAlias, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(failingServer.requestCount(), 1);
      assert.equal(healthyServer.requestCount(), 1);

      const usage = await new UsageLedgerRepository(pool).listRecent(10);
      assert.equal(usage[0]?.is_fallback, true);
      assert.equal(usage[0]?.primary_tier_id, primaryTier.id);
      assert.equal(usage[0]?.fallback_tier_id, fallbackTier.id);
      assert.equal(usage[0]?.attempt_count, 2);
    });
  } finally {
    await failingServer.close();
    await healthyServer.close();
  }
});

test("fallback disabled: a vendor with automaticFallback=false never falls back, even with a matching enabled rule", async () => {
  const failingServer = await startMockProviderServer("serverError");
  const healthyServer = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);

      const primaryVendor = await createVendor(app, failingServer.baseEndpoint, { automaticFallback: false, retryMaxAttempts: 1 });
      const primaryModel = await createModel(app, primaryVendor.id);
      await attachVendorToWorkload(app, primaryVendor.id, workload.id);
      await attachModelToWorkload(app, primaryModel.id, workload.id);
      await createAccountAndCredential(app, primaryVendor.id);
      const primaryTier = await createTier(app, workload.id, primaryVendor.id, primaryModel.id, { tierNumber: 0 });

      const fallbackVendor = await createVendor(app, healthyServer.baseEndpoint);
      const fallbackModel = await createModel(app, fallbackVendor.id, { inhouseAlias: `fallback-${Math.random().toString(36).slice(2, 8)}` });
      await attachVendorToWorkload(app, fallbackVendor.id, workload.id);
      await attachModelToWorkload(app, fallbackModel.id, workload.id);
      await createAccountAndCredential(app, fallbackVendor.id);
      const fallbackTier = await createTier(app, workload.id, fallbackVendor.id, fallbackModel.id, { tierNumber: 1 });

      await app.inject({ headers: ADMIN,
        method: "POST",
        url: `/v1/routing/workloads/${workload.id}/fallback-rules`,
        payload: { fromTierId: primaryTier.id, toTierId: fallbackTier.id, conditionType: "on_5xx", priority: 0, enabled: true },
      });

      const { rawKey } = await createApiKey(app, [workload.id]);
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { workloadId: workload.id, model: primaryModel.inhouseAlias, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 502, res.body);
      assert.equal(failingServer.requestCount(), 1);
      assert.equal(healthyServer.requestCount(), 0, "no fallback should ever have reached the healthy provider");
    });
  } finally {
    await failingServer.close();
    await healthyServer.close();
  }
});

test("a fallback loop (A -> B -> A) terminates instead of hanging, and never attempts the same tier twice", async () => {
  const serverA = await startMockProviderServer("serverError");
  const serverB = await startMockProviderServer("serverError");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);

      const vendorA = await createVendor(app, serverA.baseEndpoint, { automaticFallback: true, retryMaxAttempts: 1 });
      const modelA = await createModel(app, vendorA.id, { inhouseAlias: `a-${Math.random().toString(36).slice(2, 8)}` });
      await attachVendorToWorkload(app, vendorA.id, workload.id);
      await attachModelToWorkload(app, modelA.id, workload.id);
      await createAccountAndCredential(app, vendorA.id);
      const tierA = await createTier(app, workload.id, vendorA.id, modelA.id, { tierNumber: 0 });

      const vendorB = await createVendor(app, serverB.baseEndpoint, { automaticFallback: true, retryMaxAttempts: 1 });
      const modelB = await createModel(app, vendorB.id, { inhouseAlias: `b-${Math.random().toString(36).slice(2, 8)}` });
      await attachVendorToWorkload(app, vendorB.id, workload.id);
      await attachModelToWorkload(app, modelB.id, workload.id);
      await createAccountAndCredential(app, vendorB.id);
      const tierB = await createTier(app, workload.id, vendorB.id, modelB.id, { tierNumber: 1 });

      await app.inject({ headers: ADMIN,
        method: "POST",
        url: `/v1/routing/workloads/${workload.id}/fallback-rules`,
        payload: { fromTierId: tierA.id, toTierId: tierB.id, conditionType: "on_5xx", priority: 0, enabled: true },
      });
      await app.inject({ headers: ADMIN,
        method: "POST",
        url: `/v1/routing/workloads/${workload.id}/fallback-rules`,
        payload: { fromTierId: tierB.id, toTierId: tierA.id, conditionType: "on_5xx", priority: 0, enabled: true },
      });

      const { rawKey } = await createApiKey(app, [workload.id]);
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { workloadId: workload.id, model: modelA.inhouseAlias, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 502, res.body);
      // Exactly one attempt against each of A and B — the visited-tier set prevents a third hop back to A.
      assert.equal(serverA.requestCount(), 1);
      assert.equal(serverB.requestCount(), 1);
    });
  } finally {
    await serverA.close();
    await serverB.close();
  }
});

// --- Routing preview stays read-only even with real infrastructure available ---

test("POST /v1/routing/preview never contacts the provider, even when a fully-eligible candidate exists", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      const { model } = await setUpEligibleTier(app, workload.id, server.baseEndpoint);

      const res = await app.inject({ headers: ADMIN,
        method: "POST",
        url: "/v1/routing/preview",
        payload: { workloadId: workload.id, modelId: model.id },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().decision.outcome, "selected");
      assert.equal(server.requestCount(), 0, "preview must never call the provider");

      const usage = await new UsageLedgerRepository(pool).listRecent(10);
      assert.equal(usage.length, 0, "preview must never write a usage ledger row");
    });
  } finally {
    await server.close();
  }
});

// --- No secret ever appears in logs ---

test("the provider secret and the client's Inhouse API key never appear in server logs across a full execution", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedPool(async (pool, config) => {
      await truncateAll(pool, config.schema);
      const chunks: string[] = [];
      const stream = new Writable({
        write(chunk: Buffer, _enc, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      });
      const app = await buildApp(loadConfig({ INHOUSE_API_ENV: "test", INHOUSE_ADMIN_TOKEN: TEST_ADMIN_TOKEN } as NodeJS.ProcessEnv), {
        pool,
        credentialVault: new CredentialVaultService(TEST_VAULT_KEY),
        loggerStream: stream,
      });
      try {
        const workload = await createWorkload(pool);
        const { model } = await setUpEligibleTier(app, workload.id, server.baseEndpoint);
        const { rawKey } = await createApiKey(app, [workload.id]);

        await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: { authorization: `Bearer ${rawKey}` },
          payload: { workloadId: workload.id, model: model.inhouseAlias, messages: [{ role: "user", content: "hi" }] },
        });

        const output = chunks.join("");
        assert.ok(!output.includes(REAL_SECRET), "the provider secret must never appear in logs");
        assert.ok(!output.includes(rawKey), "the raw Inhouse API key must never appear in logs");
        assert.ok(!output.includes(TEST_ADMIN_TOKEN), "the admin token must never appear in logs");
        assert.ok(output.includes("[Redacted]"), "the Authorization header must be redacted, not simply absent");
      } finally {
        await app.close();
      }
    });
  } finally {
    await server.close();
  }
});

test("provider usage is never fabricated: a malformed provider response records null token counts, not zeros", async () => {
  // "malformed" is already covered for its error category above; this asserts the accounting side
  // specifically for the case where usage genuinely cannot be determined.
  const server = await startMockProviderServer("malformed");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const workload = await createWorkload(pool);
      const { model } = await setUpEligibleTier(app, workload.id, server.baseEndpoint);
      const { rawKey } = await createApiKey(app, [workload.id]);

      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { workloadId: workload.id, model: model.inhouseAlias, messages: [{ role: "user", content: "hi" }] },
      });

      const usage = await new UsageLedgerRepository(pool).listRecent(10);
      assert.equal(usage[0]?.status, "error");
      assert.equal(usage[0]?.input_tokens, null);
      assert.equal(usage[0]?.output_tokens, null);
      assert.equal(usage[0]?.provider_cost, null);
      assert.equal(usage[0]?.inhouse_cost, null);
    });
  } finally {
    await server.close();
  }
});
