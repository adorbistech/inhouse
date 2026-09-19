import assert from "node:assert/strict";
import { test } from "node:test";
import { withMigratedPool, truncateAll } from "./helpers.js";
import { VendorsRepository } from "../../src/repositories/vendorsRepository.js";
import { VendorAccountsRepository } from "../../src/repositories/vendorAccountsRepository.js";
import { ModelsRepository } from "../../src/repositories/modelsRepository.js";
import { CapabilitiesRepository } from "../../src/repositories/capabilitiesRepository.js";
import { WorkloadsRepository } from "../../src/repositories/workloadsRepository.js";
import { RoutingRepository } from "../../src/repositories/routingRepository.js";
import { ApiKeysRepository } from "../../src/repositories/apiKeysRepository.js";
import { UsageLedgerRepository } from "../../src/repositories/usageLedgerRepository.js";
import { AuditEventsRepository } from "../../src/repositories/auditEventsRepository.js";
import { hashApiKey } from "../../src/lib/apiKeyHash.js";

const sampleVendor = {
  slug: "test-vendor",
  display_name: "Test Vendor",
  vendor_type: "llm",
  protocol: "https",
  base_endpoint: "https://example.invalid",
  description: null,
  status: "active",
  billing_type: "metered",
  default_tier: 1,
  max_tier: 3,
  automatic_fallback: true,
  timeout_ms: 5000,
  retry_max_attempts: 2,
  retry_backoff_ms: 250,
};

test("vendor repository creates and reads back a vendor", async () => {
  await withMigratedPool(async (pool, config) => {
    await truncateAll(pool, config.schema);
    const repo = new VendorsRepository(pool);

    const created = await repo.create(sampleVendor);
    assert.ok(created.id);
    assert.equal(created.slug, "test-vendor");

    const found = await repo.findBySlug("test-vendor");
    assert.equal(found?.id, created.id);

    const list = await repo.list();
    assert.equal(list.length, 1);
  });
});

test("vendor account relationship: an account belongs to exactly its vendor", async () => {
  await withMigratedPool(async (pool, config) => {
    await truncateAll(pool, config.schema);
    const vendors = new VendorsRepository(pool);
    const accounts = new VendorAccountsRepository(pool);

    const vendorA = await vendors.create({ ...sampleVendor, slug: "vendor-a" });
    const vendorB = await vendors.create({ ...sampleVendor, slug: "vendor-b" });

    await accounts.create({
      vendor_id: vendorA.id,
      slug: "acct-a1",
      display_name: "A1",
      status: "active",
      external_account_ref: null,
    });
    await accounts.create({
      vendor_id: vendorB.id,
      slug: "acct-b1",
      display_name: "B1",
      status: "active",
      external_account_ref: null,
    });

    const vendorAAccounts = await accounts.listByVendorId(vendorA.id);
    assert.equal(vendorAAccounts.length, 1);
    assert.equal(vendorAAccounts[0]?.slug, "acct-a1");
  });
});

test("model relationship: a model belongs to its vendor and is unique per provider_model_id", async () => {
  await withMigratedPool(async (pool, config) => {
    await truncateAll(pool, config.schema);
    const vendors = new VendorsRepository(pool);
    const models = new ModelsRepository(pool);

    const vendor = await vendors.create(sampleVendor);
    const model = await models.create({
      vendor_id: vendor.id,
      provider_model_id: "provider-model-1",
      inhouse_alias: "inhouse-alias-1",
      display_name: "Model One",
      context_window: 128000,
      status: "active",
    });

    assert.equal(model.vendor_id, vendor.id);

    await assert.rejects(
      () =>
        models.create({
          vendor_id: vendor.id,
          provider_model_id: "provider-model-1",
          inhouse_alias: "different-alias",
          display_name: "Duplicate",
          context_window: null,
          status: "active",
        }),
      /duplicate key|unique/i,
    );
  });
});

test("capabilities attach to models through the join table", async () => {
  await withMigratedPool(async (pool, config) => {
    await truncateAll(pool, config.schema);
    const vendors = new VendorsRepository(pool);
    const models = new ModelsRepository(pool);
    const capabilities = new CapabilitiesRepository(pool);

    const vendor = await vendors.create(sampleVendor);
    const model = await models.create({
      vendor_id: vendor.id,
      provider_model_id: "provider-model-caps",
      inhouse_alias: "alias-caps",
      display_name: "Model Caps",
      context_window: null,
      status: "active",
    });
    const capability = await capabilities.create({
      slug: "vision",
      display_name: "Vision",
      description: null,
    });

    await capabilities.attachToModel(model.id, capability.id);
    const forModel = await capabilities.listForModel(model.id);
    assert.equal(forModel.length, 1);
    assert.equal(forModel[0]?.slug, "vision");
  });
});

test("workloads attach to models through the join table", async () => {
  await withMigratedPool(async (pool, config) => {
    await truncateAll(pool, config.schema);
    const vendors = new VendorsRepository(pool);
    const models = new ModelsRepository(pool);
    const workloads = new WorkloadsRepository(pool);

    const vendor = await vendors.create(sampleVendor);
    const model = await models.create({
      vendor_id: vendor.id,
      provider_model_id: "provider-model-wl",
      inhouse_alias: "alias-wl",
      display_name: "Model WL",
      context_window: null,
      status: "active",
    });
    const workload = await workloads.create({
      slug: "chat",
      display_name: "Chat",
      description: null,
      status: "active",
    });

    await workloads.attachToModel(model.id, workload.id);
    const forModel = await workloads.listForModel(model.id);
    assert.equal(forModel.length, 1);
    assert.equal(forModel[0]?.slug, "chat");
  });
});

test("routing tiers and fallback rules persist as data only", async () => {
  await withMigratedPool(async (pool, config) => {
    await truncateAll(pool, config.schema);
    const vendors = new VendorsRepository(pool);
    const models = new ModelsRepository(pool);
    const workloads = new WorkloadsRepository(pool);
    const routing = new RoutingRepository(pool);

    const vendor = await vendors.create(sampleVendor);
    const model = await models.create({
      vendor_id: vendor.id,
      provider_model_id: "provider-model-route",
      inhouse_alias: "alias-route",
      display_name: "Model Route",
      context_window: null,
      status: "active",
    });
    const workload = await workloads.create({
      slug: "routing-workload",
      display_name: "Routing Workload",
      description: null,
      status: "active",
    });

    const primaryTier = await routing.createTier({
      workload_id: workload.id,
      tier_number: 1,
      vendor_id: vendor.id,
      model_id: model.id,
      priority: 0,
      enabled: true,
      timeout_override_ms: null,
      max_attempts: 3,
    });
    const fallbackTier = await routing.createTier({
      workload_id: workload.id,
      tier_number: 2,
      vendor_id: vendor.id,
      model_id: model.id,
      priority: 1,
      enabled: true,
      timeout_override_ms: null,
      max_attempts: 3,
    });

    await routing.createFallbackRule({
      workload_id: workload.id,
      from_tier_id: primaryTier.id,
      to_tier_id: fallbackTier.id,
      condition_type: "on_timeout",
      condition_config: { thresholdMs: 5000 },
      priority: 0,
      enabled: true,
    });

    const tiers = await routing.listTiersForWorkload(workload.id);
    assert.equal(tiers.length, 2);

    const rules = await routing.listFallbackRulesForWorkload(workload.id);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.condition_type, "on_timeout");
  });
});

test("API keys are persisted only as a hash — the raw key is never stored", async () => {
  await withMigratedPool(async (pool, config) => {
    await truncateAll(pool, config.schema);
    const repo = new ApiKeysRepository(pool);
    const rawKey = "inhouse_sk_test_raw_value_never_persisted";

    const created = await repo.createWithRawKey(rawKey, {
      keyId: "key_1",
      name: "Test Key",
      permissions: [],
      status: "active",
      expiresAt: null,
    });

    assert.equal(created.key_hash, hashApiKey(rawKey));
    assert.ok(!("raw_key" in created));

    const rawColumns = Object.values(created).map((value) => String(value));
    assert.ok(!rawColumns.includes(rawKey), "the raw key must never appear in a persisted row");

    const found = await repo.findByRawKey(rawKey);
    assert.equal(found?.id, created.id);

    const notFound = await repo.findByRawKey("wrong-key");
    assert.equal(notFound, null);
  });
});

test("usage ledger entries persist execution metadata", async () => {
  await withMigratedPool(async (pool, config) => {
    await truncateAll(pool, config.schema);
    const repo = new UsageLedgerRepository(pool);

    const entry = await repo.create({
      inhouse_api_key_id: null,
      vendor_id: null,
      vendor_account_id: null,
      model_id: null,
      workload_id: null,
      primary_tier_id: null,
      fallback_tier_id: null,
      is_fallback: false,
      status: "success",
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      latency_ms: 820,
      error_category: null,
      provider_cost: "0.002500",
      inhouse_cost: "0.003000",
      currency: "USD",
    });

    assert.equal(entry.status, "success");
    const recent = await repo.listRecent(10);
    assert.equal(recent.length, 1);
  });
});

test("audit events persist actor/action/resource metadata without secrets", async () => {
  await withMigratedPool(async (pool, config) => {
    await truncateAll(pool, config.schema);
    const repo = new AuditEventsRepository(pool);

    const event = await repo.create({
      actor_id: "test-actor",
      action: "vendor.created",
      resource_type: "vendor",
      resource_id: "some-vendor-id",
      metadata: { note: "created via test" },
      request_id: "req-123",
    });

    assert.equal(event.action, "vendor.created");
    const forResource = await repo.listForResource("vendor", "some-vendor-id");
    assert.equal(forResource.length, 1);
  });
});

test("repositories use parameterized queries, never string-interpolated values", async () => {
  await withMigratedPool(async (pool, config) => {
    await truncateAll(pool, config.schema);
    const vendors = new VendorsRepository(pool);

    const maliciousSlug = "'; DROP TABLE vendors; --";
    const created = await vendors.create({ ...sampleVendor, slug: maliciousSlug });

    assert.equal(created.slug, maliciousSlug);
    const stillThere = await vendors.list();
    assert.equal(stillThere.length, 1, "the vendors table must survive an injection-shaped value");
  });
});
