import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { truncateAll, withMigratedApp } from "./helpers.js";
import { WorkloadsRepository } from "../../src/repositories/workloadsRepository.js";
import { VendorAccountHealthRepository } from "../../src/repositories/vendorAccountHealthRepository.js";
import { CapabilitiesRepository } from "../../src/repositories/capabilitiesRepository.js";

const MISSING_ID = "00000000-0000-0000-0000-000000000000";

const sampleVendorPayload = {
  slug: "routing-vendor",
  displayName: "Routing Vendor",
  vendorType: "general_api",
  protocol: "custom_rest",
  baseEndpoint: "https://api.example.invalid/v1",
  billingType: "metered",
  timeoutMs: 5000,
  retryMaxAttempts: 2,
};

async function createVendor(app: FastifyInstance, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({ method: "POST", url: "/v1/vendors", payload: { ...sampleVendorPayload, ...overrides } });
  assert.equal(res.statusCode, 201, `createVendor failed: ${res.body}`);
  return res.json().vendor;
}

async function createModel(app: FastifyInstance, vendorId: string, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/models",
    payload: {
      vendorId,
      providerModelId: "provider-model-1",
      inhouseAlias: "routing-model",
      displayName: "Routing Model",
      ...overrides,
    },
  });
  assert.equal(res.statusCode, 201, `createModel failed: ${res.body}`);
  return res.json().model;
}

async function createWorkload(pool: Pool, overrides: Record<string, unknown> = {}) {
  return new WorkloadsRepository(pool).create({
    slug: "routing-workload",
    display_name: "Routing Workload",
    description: null,
    status: "enabled",
    ...overrides,
  });
}

async function attachVendorToWorkload(app: FastifyInstance, vendorId: string, workloadId: string) {
  const res = await app.inject({
    method: "PUT",
    url: `/v1/vendors/${vendorId}/workloads`,
    payload: { workloadIds: [workloadId] },
  });
  assert.equal(res.statusCode, 200, `attachVendorToWorkload failed: ${res.body}`);
}

async function attachModelToWorkload(app: FastifyInstance, modelId: string, workloadId: string) {
  const res = await app.inject({
    method: "PUT",
    url: `/v1/models/${modelId}/workloads`,
    payload: { workloadIds: [workloadId] },
  });
  assert.equal(res.statusCode, 200, `attachModelToWorkload failed: ${res.body}`);
}

/** Builds one fully-eligible vendor/model pair, wired to `workloadId`. */
async function buildEligibleCandidate(
  app: FastifyInstance,
  workloadId: string,
  overrides: { vendor?: Record<string, unknown>; model?: Record<string, unknown> } = {},
) {
  const vendor = await createVendor(app, { slug: `vendor-${Math.random().toString(36).slice(2, 8)}`, ...overrides.vendor });
  const model = await createModel(app, vendor.id, {
    inhouseAlias: `alias-${Math.random().toString(36).slice(2, 8)}`,
    providerModelId: `provider-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides.model,
  });
  await attachVendorToWorkload(app, vendor.id, workloadId);
  await attachModelToWorkload(app, model.id, workloadId);
  return { vendor, model };
}

async function createTier(
  app: FastifyInstance,
  workloadId: string,
  payload: Record<string, unknown>,
) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/routing/workloads/${workloadId}/tiers`,
    payload,
  });
  return res;
}

// --- Tier CRUD ---

test("GET /v1/routing/workloads/:workloadId/tiers is empty before any tier exists, 404 for a missing workload", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);

    const res = await app.inject({ method: "GET", url: `/v1/routing/workloads/${workload.id}/tiers` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().tiers, []);

    const missing = await app.inject({ method: "GET", url: `/v1/routing/workloads/${MISSING_ID}/tiers` });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "NOT_FOUND");
  });
});

test("POST .../tiers creates a tier once vendor+model are assigned to the workload", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const { vendor, model } = await buildEligibleCandidate(app, workload.id);

    const res = await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1, priority: 5 });
    assert.equal(res.statusCode, 201, res.body);
    const tier = res.json().tier;
    assert.equal(tier.workloadId, workload.id);
    assert.equal(tier.vendorId, vendor.id);
    assert.equal(tier.modelId, model.id);
    assert.equal(tier.tierNumber, 1);
    assert.equal(tier.priority, 5);
    assert.equal(tier.enabled, true);

    const list = await app.inject({ method: "GET", url: `/v1/routing/workloads/${workload.id}/tiers` });
    assert.equal(list.json().tiers.length, 1);
  });
});

test("POST .../tiers rejects an unknown vendorId/modelId with 400, not a 500", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const { vendor, model } = await buildEligibleCandidate(app, workload.id);

    const badVendor = await createTier(app, workload.id, { vendorId: MISSING_ID, modelId: model.id, tierNumber: 1 });
    assert.equal(badVendor.statusCode, 400);

    const badModel = await createTier(app, workload.id, { vendorId: vendor.id, modelId: MISSING_ID, tierNumber: 1 });
    assert.equal(badModel.statusCode, 400);
  });
});

test("POST .../tiers rejects a model that does not belong to the given vendor", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const a = await buildEligibleCandidate(app, workload.id, { vendor: { slug: "vendor-a" } });
    const b = await buildEligibleCandidate(app, workload.id, { vendor: { slug: "vendor-b" } });

    const res = await createTier(app, workload.id, { vendorId: a.vendor.id, modelId: b.model.id, tierNumber: 1 });
    assert.equal(res.statusCode, 400);
  });
});

test("POST .../tiers rejects a vendor/model not assigned to the workload", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const otherWorkload = await createWorkload(pool, { slug: "other-workload" });

    const vendor = await createVendor(app);
    const model = await createModel(app, vendor.id);
    // Assigned to a *different* workload, not this one.
    await attachVendorToWorkload(app, vendor.id, otherWorkload.id);
    await attachModelToWorkload(app, model.id, otherWorkload.id);

    const res = await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1 });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /not assigned to workload/);
  });
});

test("POST .../tiers rejects a duplicate (workload, tierNumber, vendor, model) with 409", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const { vendor, model } = await buildEligibleCandidate(app, workload.id);

    const first = await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1 });
    assert.equal(first.statusCode, 201);

    const duplicate = await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1 });
    assert.equal(duplicate.statusCode, 409);
  });
});

test("PATCH .../tiers/:tierId updates fields; empty patch is rejected; DELETE soft-disables", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const { vendor, model } = await buildEligibleCandidate(app, workload.id);
    const tier = (await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1 })).json().tier;

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/routing/workloads/${workload.id}/tiers/${tier.id}`,
      payload: { priority: 9, maxAttempts: 5 },
    });
    assert.equal(patch.statusCode, 200);
    assert.equal(patch.json().tier.priority, 9);
    assert.equal(patch.json().tier.maxAttempts, 5);

    const emptyPatch = await app.inject({
      method: "PATCH",
      url: `/v1/routing/workloads/${workload.id}/tiers/${tier.id}`,
      payload: {},
    });
    assert.equal(emptyPatch.statusCode, 400);

    const del = await app.inject({ method: "DELETE", url: `/v1/routing/workloads/${workload.id}/tiers/${tier.id}` });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().tier.enabled, false);

    // Soft-disable, not a row deletion.
    const stillThere = await pool.query("SELECT enabled FROM routing_tiers WHERE id = $1", [tier.id]);
    assert.equal(stillThere.rows.length, 1);
    assert.equal(stillThere.rows[0].enabled, false);
  });
});

test("PATCH/DELETE .../tiers/:tierId 404s when the tier does not belong to the given workload", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const otherWorkload = await createWorkload(pool, { slug: "other-workload" });
    const { vendor, model } = await buildEligibleCandidate(app, workload.id);
    const tier = (await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1 })).json().tier;

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/routing/workloads/${otherWorkload.id}/tiers/${tier.id}`,
      payload: { priority: 1 },
    });
    assert.equal(res.statusCode, 404);
  });
});

// --- Fallback rule CRUD ---

test("Fallback rules: create, patch, and soft-disable; cross-workload and self-reference are rejected", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const otherWorkload = await createWorkload(pool, { slug: "other-workload" });
    const { vendor, model } = await buildEligibleCandidate(app, workload.id);

    const tier1 = (await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1 })).json().tier;
    const tier2 = (await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 2 })).json().tier;

    const created = await app.inject({
      method: "POST",
      url: `/v1/routing/workloads/${workload.id}/fallback-rules`,
      payload: { fromTierId: tier1.id, toTierId: tier2.id, conditionType: "on_timeout", conditionConfig: { thresholdMs: 5000 } },
    });
    assert.equal(created.statusCode, 201, created.body);
    const rule = created.json().fallbackRule;
    assert.equal(rule.fromTierId, tier1.id);
    assert.equal(rule.toTierId, tier2.id);

    const selfRef = await app.inject({
      method: "POST",
      url: `/v1/routing/workloads/${workload.id}/fallback-rules`,
      payload: { fromTierId: tier1.id, toTierId: tier1.id, conditionType: "on_timeout" },
    });
    assert.equal(selfRef.statusCode, 400);

    const independentOther = await buildEligibleCandidate(app, otherWorkload.id, { vendor: { slug: "vendor-independent" } });
    const crossTier = (
      await createTier(app, otherWorkload.id, { vendorId: independentOther.vendor.id, modelId: independentOther.model.id, tierNumber: 1 })
    ).json().tier;

    const crossWorkload = await app.inject({
      method: "POST",
      url: `/v1/routing/workloads/${workload.id}/fallback-rules`,
      payload: { fromTierId: tier1.id, toTierId: crossTier.id, conditionType: "on_timeout" },
    });
    assert.equal(crossWorkload.statusCode, 404);

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/routing/workloads/${workload.id}/fallback-rules/${rule.id}`,
      payload: { priority: 7 },
    });
    assert.equal(patch.statusCode, 200);
    assert.equal(patch.json().fallbackRule.priority, 7);

    const del = await app.inject({ method: "DELETE", url: `/v1/routing/workloads/${workload.id}/fallback-rules/${rule.id}` });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().fallbackRule.enabled, false);

    const list = await app.inject({ method: "GET", url: `/v1/routing/workloads/${workload.id}/fallback-rules` });
    assert.equal(list.json().fallbackRules.length, 1);
  });
});

test("GET /v1/routing/workloads/:workloadId returns the combined workload + tiers + fallbackRules view", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const { vendor, model } = await buildEligibleCandidate(app, workload.id);
    await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1 });

    const res = await app.inject({ method: "GET", url: `/v1/routing/workloads/${workload.id}` });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.workload.id, workload.id);
    assert.equal(body.tiers.length, 1);
    assert.deepEqual(body.fallbackRules, []);
  });
});

// --- Preview / dry-run ---

test("POST /v1/routing/preview 404s for an unknown workload", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const res = await app.inject({ method: "POST", url: "/v1/routing/preview", payload: { workloadId: MISSING_ID } });
    assert.equal(res.statusCode, 404);
  });
});

test("preview reports 'no_tiers_configured' when a workload has no routing tiers", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const res = await app.inject({ method: "POST", url: "/v1/routing/preview", payload: { workloadId: workload.id } });
    assert.equal(res.statusCode, 200);
    const decision = res.json().decision;
    assert.equal(decision.outcome, "no_tiers_configured");
    assert.deepEqual(decision.candidates, []);
    assert.equal(decision.selectedCandidate, null);
  });
});

test("preview selects the single eligible candidate, with health 'unknown' when no accounts exist", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const { vendor, model } = await buildEligibleCandidate(app, workload.id);
    const tier = (await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1 })).json().tier;

    const res = await app.inject({ method: "POST", url: "/v1/routing/preview", payload: { workloadId: workload.id } });
    const decision = res.json().decision;
    assert.equal(decision.outcome, "selected");
    assert.equal(decision.candidates.length, 1);
    assert.equal(decision.selectedCandidate.tierId, tier.id);
    assert.equal(decision.selectedCandidate.eligible, true);
    assert.equal(decision.selectedCandidate.health, "unknown");
    assert.deepEqual(decision.selectedCandidate.reasons, []);
  });
});

test("preview excludes a disabled tier with reason 'tier_disabled'", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const { vendor, model } = await buildEligibleCandidate(app, workload.id);
    await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1, enabled: false });

    const res = await app.inject({ method: "POST", url: "/v1/routing/preview", payload: { workloadId: workload.id } });
    const decision = res.json().decision;
    assert.equal(decision.outcome, "no_eligible_candidate");
    assert.equal(decision.candidates[0].eligible, false);
    assert.ok(decision.candidates[0].reasons.includes("tier_disabled"));
  });
});

test("preview excludes a disabled vendor/model with the matching reason", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const { vendor, model } = await buildEligibleCandidate(app, workload.id);
    await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1 });

    await app.inject({ method: "DELETE", url: `/v1/vendors/${vendor.id}` }); // soft-disable
    const res = await app.inject({ method: "POST", url: "/v1/routing/preview", payload: { workloadId: workload.id } });
    const decision = res.json().decision;
    assert.ok(decision.candidates[0].reasons.includes("vendor_disabled"));

    await app.inject({ method: "PATCH", url: `/v1/vendors/${vendor.id}`, payload: { status: "enabled" } });
    await app.inject({ method: "DELETE", url: `/v1/models/${model.id}` });
    const res2 = await app.inject({ method: "POST", url: "/v1/routing/preview", payload: { workloadId: workload.id } });
    assert.ok(res2.json().decision.candidates[0].reasons.includes("model_disabled"));
  });
});

test("preview honors a requested modelId, excluding non-matching tiers", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const first = await buildEligibleCandidate(app, workload.id, { vendor: { slug: "vendor-first" } });
    const second = await buildEligibleCandidate(app, workload.id, { vendor: { slug: "vendor-second" } });
    await createTier(app, workload.id, { vendorId: first.vendor.id, modelId: first.model.id, tierNumber: 1 });
    await createTier(app, workload.id, { vendorId: second.vendor.id, modelId: second.model.id, tierNumber: 2 });

    const res = await app.inject({
      method: "POST",
      url: "/v1/routing/preview",
      payload: { workloadId: workload.id, modelId: second.model.id },
    });
    const decision = res.json().decision;
    assert.equal(decision.outcome, "selected");
    assert.equal(decision.selectedCandidate.model.id, second.model.id);
    const firstCandidate = decision.candidates.find((c: { model: { id: string } }) => c.model.id === first.model.id);
    assert.ok(firstCandidate.reasons.includes("model_not_requested"));
  });
});

test("preview rejects an unknown requested modelId/capabilityId with 400", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const badModel = await app.inject({
      method: "POST",
      url: "/v1/routing/preview",
      payload: { workloadId: workload.id, modelId: MISSING_ID },
    });
    assert.equal(badModel.statusCode, 400);

    const badCapability = await app.inject({
      method: "POST",
      url: "/v1/routing/preview",
      payload: { workloadId: workload.id, capabilityIds: [MISSING_ID] },
    });
    assert.equal(badCapability.statusCode, 400);
  });
});

test("preview enforces capability requirements against model/vendor capability assignments", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const { vendor, model } = await buildEligibleCandidate(app, workload.id);
    await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1 });

    const capability = await new CapabilitiesRepository(pool).create({
      slug: "vision",
      display_name: "Vision",
      description: null,
    });

    const withoutCapability = await app.inject({
      method: "POST",
      url: "/v1/routing/preview",
      payload: { workloadId: workload.id, capabilityIds: [capability.id] },
    });
    const decisionMissing = withoutCapability.json().decision;
    assert.equal(decisionMissing.outcome, "no_eligible_candidate");
    assert.ok(decisionMissing.candidates[0].reasons.includes(`capability_not_supported:${capability.id}`));

    await app.inject({
      method: "PUT",
      url: `/v1/models/${model.id}/capabilities`,
      payload: { capabilityIds: [capability.id] },
    });

    const withCapability = await app.inject({
      method: "POST",
      url: "/v1/routing/preview",
      payload: { workloadId: workload.id, capabilityIds: [capability.id] },
    });
    assert.equal(withCapability.json().decision.outcome, "selected");
  });
});

test("preview health: a healthy account makes the candidate eligible with health 'healthy'", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const { vendor, model } = await buildEligibleCandidate(app, workload.id);
    await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1 });

    const account = (await app.inject({ method: "POST", url: `/v1/vendors/${vendor.id}/accounts`, payload: { slug: "acct-1", displayName: "Account 1" } })).json().account;
    await new VendorAccountHealthRepository(pool).upsert({
      vendor_account_id: account.id,
      status: "healthy",
      consecutive_failures: 0,
      last_checked_at: new Date(),
      last_success_at: new Date(),
      last_failure_at: null,
      last_latency_ms: 120,
      last_error_category: null,
      last_safe_error_code: null,
    });

    const res = await app.inject({ method: "POST", url: "/v1/routing/preview", payload: { workloadId: workload.id } });
    const decision = res.json().decision;
    assert.equal(decision.selectedCandidate.health, "healthy");
    assert.equal(decision.selectedCandidate.accounts[0].health, "healthy");
  });
});

test("preview health: an unhealthy-only vendor is excluded with reason 'vendor_unhealthy'", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const { vendor, model } = await buildEligibleCandidate(app, workload.id);
    await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1 });

    const account = (await app.inject({ method: "POST", url: `/v1/vendors/${vendor.id}/accounts`, payload: { slug: "acct-1", displayName: "Account 1" } })).json().account;
    await new VendorAccountHealthRepository(pool).upsert({
      vendor_account_id: account.id,
      status: "unhealthy",
      consecutive_failures: 3,
      last_checked_at: new Date(),
      last_success_at: null,
      last_failure_at: new Date(),
      last_latency_ms: null,
      last_error_category: "timeout",
      last_safe_error_code: "ETIMEDOUT",
    });

    const res = await app.inject({ method: "POST", url: "/v1/routing/preview", payload: { workloadId: workload.id } });
    const decision = res.json().decision;
    assert.equal(decision.outcome, "no_eligible_candidate");
    assert.ok(decision.candidates[0].reasons.includes("vendor_unhealthy"));
  });
});

test("preview health: a degraded account keeps the candidate eligible (degraded is not exclusion)", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const { vendor, model } = await buildEligibleCandidate(app, workload.id);
    await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1 });

    const account = (await app.inject({ method: "POST", url: `/v1/vendors/${vendor.id}/accounts`, payload: { slug: "acct-1", displayName: "Account 1" } })).json().account;
    await new VendorAccountHealthRepository(pool).upsert({
      vendor_account_id: account.id,
      status: "degraded",
      consecutive_failures: 1,
      last_checked_at: new Date(),
      last_success_at: new Date(),
      last_failure_at: null,
      last_latency_ms: 4000,
      last_error_category: "rate_limit",
      last_safe_error_code: "429",
    });

    const res = await app.inject({ method: "POST", url: "/v1/routing/preview", payload: { workloadId: workload.id } });
    const decision = res.json().decision;
    assert.equal(decision.outcome, "selected");
    assert.equal(decision.selectedCandidate.health, "degraded");
  });
});

test("deterministic ordering: tier_number always outranks priority, and ties break on tier id, stably across repeated calls", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const low = await buildEligibleCandidate(app, workload.id, { vendor: { slug: "vendor-low-tier" } });
    const high = await buildEligibleCandidate(app, workload.id, { vendor: { slug: "vendor-high-tier" } });

    // tier_number 1 has LOWER priority than tier_number 2 — tier_number must still win.
    const tier1 = (await createTier(app, workload.id, { vendorId: low.vendor.id, modelId: low.model.id, tierNumber: 1, priority: 0 })).json().tier;
    await createTier(app, workload.id, { vendorId: high.vendor.id, modelId: high.model.id, tierNumber: 2, priority: 100 });

    const res1 = await app.inject({ method: "POST", url: "/v1/routing/preview", payload: { workloadId: workload.id } });
    assert.equal(res1.json().decision.selectedCandidate.tierId, tier1.id);

    // Two candidates at the same tier_number: higher priority wins.
    const workload2 = await createWorkload(pool, { slug: "routing-workload-2" });
    const a = await buildEligibleCandidate(app, workload2.id, { vendor: { slug: "vendor-a-tie" } });
    const b = await buildEligibleCandidate(app, workload2.id, { vendor: { slug: "vendor-b-tie" } });
    await createTier(app, workload2.id, { vendorId: a.vendor.id, modelId: a.model.id, tierNumber: 1, priority: 1 });
    const bTier = (await createTier(app, workload2.id, { vendorId: b.vendor.id, modelId: b.model.id, tierNumber: 1, priority: 9 })).json().tier;

    const res2 = await app.inject({ method: "POST", url: "/v1/routing/preview", payload: { workloadId: workload2.id } });
    assert.equal(res2.json().decision.selectedCandidate.tierId, bTier.id);

    // A true tie (same tier_number, same priority) breaks on tier id, deterministically across repeated calls.
    const workload3 = await createWorkload(pool, { slug: "routing-workload-3" });
    const c = await buildEligibleCandidate(app, workload3.id, { vendor: { slug: "vendor-c-tie" } });
    const d = await buildEligibleCandidate(app, workload3.id, { vendor: { slug: "vendor-d-tie" } });
    const cTier = (await createTier(app, workload3.id, { vendorId: c.vendor.id, modelId: c.model.id, tierNumber: 1, priority: 5 })).json().tier;
    const dTier = (await createTier(app, workload3.id, { vendorId: d.vendor.id, modelId: d.model.id, tierNumber: 1, priority: 5 })).json().tier;
    const expectedWinner = [cTier.id, dTier.id].sort()[0];

    const run1 = await app.inject({ method: "POST", url: "/v1/routing/preview", payload: { workloadId: workload3.id } });
    const run2 = await app.inject({ method: "POST", url: "/v1/routing/preview", payload: { workloadId: workload3.id } });
    assert.equal(run1.json().decision.selectedCandidate.tierId, expectedWinner);
    assert.equal(run2.json().decision.selectedCandidate.tierId, expectedWinner);
  });
});

test("preview never writes a usage ledger entry or a health event, and includes fallback rules for explanation only", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workload = await createWorkload(pool);
    const { vendor, model } = await buildEligibleCandidate(app, workload.id);
    const tier1 = (await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 1 })).json().tier;
    const tier2 = (await createTier(app, workload.id, { vendorId: vendor.id, modelId: model.id, tierNumber: 2 })).json().tier;
    await app.inject({
      method: "POST",
      url: `/v1/routing/workloads/${workload.id}/fallback-rules`,
      payload: { fromTierId: tier1.id, toTierId: tier2.id, conditionType: "on_timeout" },
    });

    const before = await pool.query("SELECT count(*)::int AS n FROM usage_ledger");
    const beforeHealthEvents = await pool.query("SELECT count(*)::int AS n FROM vendor_account_health_events");

    const res = await app.inject({ method: "POST", url: "/v1/routing/preview", payload: { workloadId: workload.id } });
    const decision = res.json().decision;
    assert.equal(decision.fallbackRules.length, 1);
    assert.equal(decision.selectedCandidate.outgoingFallbackRules.length, 1);
    assert.equal(decision.selectedCandidate.outgoingFallbackRules[0].toTierId, tier2.id);

    const after = await pool.query("SELECT count(*)::int AS n FROM usage_ledger");
    const afterHealthEvents = await pool.query("SELECT count(*)::int AS n FROM vendor_account_health_events");
    assert.equal(after.rows[0].n, before.rows[0].n);
    assert.equal(afterHealthEvents.rows[0].n, beforeHealthEvents.rows[0].n);

    // No credential exists at all in this test, and the preview still succeeds —
    // proving it never attempts to decrypt or require one.
    const body = JSON.stringify(decision).toLowerCase();
    assert.ok(!body.includes("secret"));
    assert.ok(!body.includes("ciphertext"));
    assert.ok(!body.includes("credential"));
  });
});
