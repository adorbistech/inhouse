import assert from "node:assert/strict";
import { ADMIN } from "./helpers.js";
import { test } from "node:test";
import { withMigratedApp, truncateAll } from "./helpers.js";
import { CapabilitiesRepository } from "../../src/repositories/capabilitiesRepository.js";
import { WorkloadsRepository } from "../../src/repositories/workloadsRepository.js";

const sampleVendorPayload = {
  slug: "model-audit-vendor",
  displayName: "Model Audit Vendor",
  vendorType: "general_api",
  protocol: "custom_rest",
  baseEndpoint: "https://api.example.invalid/v1",
  billingType: "metered",
};

async function createVendor(app: import("fastify").FastifyInstance, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({ headers: ADMIN,
    method: "POST",
    url: "/v1/vendors",
    payload: { ...sampleVendorPayload, ...overrides },
  });
  return res.json().vendor;
}

const sampleModelPayload = (vendorId: string, overrides: Record<string, unknown> = {}) => ({
  vendorId,
  providerModelId: "provider-model-1",
  inhouseAlias: "test-model-alias",
  displayName: "Test Model",
  contextWindow: 128000,
  ...overrides,
});

const MISSING_ID = "00000000-0000-0000-0000-000000000000";

test("GET /v1/models returns an empty list before any model exists", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const res = await app.inject({ headers: ADMIN, method: "GET", url: "/v1/models" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().models, []);
  });
});

test("POST /v1/models creates a model and GET /v1/models lists it", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendor = await createVendor(app);

    const createRes = await app.inject({ headers: ADMIN,
      method: "POST",
      url: "/v1/models",
      payload: sampleModelPayload(vendor.id),
    });
    assert.equal(createRes.statusCode, 201);
    const created = createRes.json().model;
    assert.equal(created.vendorId, vendor.id);
    assert.equal(created.inhouseAlias, "test-model-alias");
    assert.equal(created.status, "enabled");
    assert.deepEqual(created.capabilities, []);

    const listRes = await app.inject({ headers: ADMIN, method: "GET", url: "/v1/models" });
    assert.equal(listRes.json().models.length, 1);
    assert.equal(listRes.json().models[0].id, created.id);
  });
});

test("GET /v1/models/:id returns model detail; 404 for a missing model", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendor = await createVendor(app);
    const created = (
      await app.inject({ headers: ADMIN, method: "POST", url: "/v1/models", payload: sampleModelPayload(vendor.id) })
    ).json().model;

    const getRes = await app.inject({ headers: ADMIN, method: "GET", url: `/v1/models/${created.id}` });
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.json().model.id, created.id);

    const missingRes = await app.inject({ headers: ADMIN, method: "GET", url: `/v1/models/${MISSING_ID}` });
    assert.equal(missingRes.statusCode, 404);
    const body = missingRes.json();
    assert.equal(body.error.code, "NOT_FOUND");
    assert.equal(body.error.requestId, missingRes.headers["x-request-id"]);
  });
});

test("POST /v1/models rejects an invalid payload with a structured 400", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendor = await createVendor(app);
    const res = await app.inject({ headers: ADMIN,
      method: "POST",
      url: "/v1/models",
      payload: sampleModelPayload(vendor.id, { inhouseAlias: undefined }),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "VALIDATION_ERROR");
  });
});

test("POST /v1/models rejects a nonexistent vendor id with a clean error, not a 500", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const res = await app.inject({ headers: ADMIN,
      method: "POST",
      url: "/v1/models",
      payload: sampleModelPayload(MISSING_ID),
    });
    assert.ok(res.statusCode === 400 || res.statusCode === 404, `expected 400/404, got ${res.statusCode}`);
    assert.ok(res.json().error);
    assert.ok(!res.body.includes("relation"));
    assert.ok(!res.body.toLowerCase().includes("at "));

    const list = await app.inject({ headers: ADMIN, method: "GET", url: "/v1/models" });
    assert.equal(list.json().models.length, 0, "no orphan model should have been created");
  });
});

test("POST /v1/models rejects a duplicate inhouse alias with 409 CONFLICT", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendor = await createVendor(app);
    const first = await app.inject({ headers: ADMIN, method: "POST", url: "/v1/models", payload: sampleModelPayload(vendor.id) });
    assert.equal(first.statusCode, 201);

    const duplicate = await app.inject({ headers: ADMIN,
      method: "POST",
      url: "/v1/models",
      payload: sampleModelPayload(vendor.id, { providerModelId: "different-provider-id" }),
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error.code, "CONFLICT");
  });
});

test("POST /v1/models rejects a duplicate (vendor, providerModelId) pair with 409, but allows the same providerModelId for a different vendor", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendorA = await createVendor(app, { slug: "vendor-a" });
    const vendorB = await createVendor(app, { slug: "vendor-b" });

    const first = await app.inject({ headers: ADMIN,
      method: "POST",
      url: "/v1/models",
      payload: sampleModelPayload(vendorA.id, { inhouseAlias: "alias-a" }),
    });
    assert.equal(first.statusCode, 201);

    const duplicate = await app.inject({ headers: ADMIN,
      method: "POST",
      url: "/v1/models",
      payload: sampleModelPayload(vendorA.id, { inhouseAlias: "alias-a-2" }),
    });
    assert.equal(duplicate.statusCode, 409);

    const otherVendor = await app.inject({ headers: ADMIN,
      method: "POST",
      url: "/v1/models",
      payload: sampleModelPayload(vendorB.id, { inhouseAlias: "alias-b" }),
    });
    assert.equal(otherVendor.statusCode, 201, "the same provider_model_id must be allowed for a different vendor");
  });
});

test("PATCH /v1/models/:id updates fields, rejects vendorId changes and empty patches", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendor = await createVendor(app);
    const created = (
      await app.inject({ headers: ADMIN, method: "POST", url: "/v1/models", payload: sampleModelPayload(vendor.id) })
    ).json().model;

    const patchRes = await app.inject({ headers: ADMIN,
      method: "PATCH",
      url: `/v1/models/${created.id}`,
      payload: { displayName: "Renamed Model", contextWindow: 200000 },
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(patchRes.json().model.displayName, "Renamed Model");
    assert.equal(patchRes.json().model.contextWindow, 200000);

    const vendorChangeAttempt = await app.inject({ headers: ADMIN,
      method: "PATCH",
      url: `/v1/models/${created.id}`,
      payload: { vendorId: MISSING_ID },
    });
    assert.equal(vendorChangeAttempt.statusCode, 400);

    const emptyPatch = await app.inject({ headers: ADMIN, method: "PATCH", url: `/v1/models/${created.id}`, payload: {} });
    assert.equal(emptyPatch.statusCode, 400);
  });
});

test("DELETE /v1/models/:id soft-disables the model rather than deleting the row", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendor = await createVendor(app);
    const created = (
      await app.inject({ headers: ADMIN, method: "POST", url: "/v1/models", payload: sampleModelPayload(vendor.id) })
    ).json().model;

    const deleteRes = await app.inject({ headers: ADMIN, method: "DELETE", url: `/v1/models/${created.id}` });
    assert.equal(deleteRes.statusCode, 200);
    assert.equal(deleteRes.json().model.status, "disabled");

    const stillThere = await pool.query("SELECT status FROM models WHERE id = $1", [created.id]);
    assert.equal(stillThere.rows.length, 1);
    assert.equal(stillThere.rows[0].status, "disabled");

    // Disabled model retrieval remains available (it's a lifecycle state, not a deletion).
    const getRes = await app.inject({ headers: ADMIN, method: "GET", url: `/v1/models/${created.id}` });
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.json().model.status, "disabled");
  });
});

test("GET /v1/models supports filtering by vendor, status, and search", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendorA = await createVendor(app, { slug: "vendor-a" });
    const vendorB = await createVendor(app, { slug: "vendor-b" });

    const modelA = (
      await app.inject({ headers: ADMIN,
        method: "POST",
        url: "/v1/models",
        payload: sampleModelPayload(vendorA.id, { inhouseAlias: "alpha-model", displayName: "Alpha Model" }),
      })
    ).json().model;
    await app.inject({ headers: ADMIN,
      method: "POST",
      url: "/v1/models",
      payload: sampleModelPayload(vendorB.id, { inhouseAlias: "beta-model", displayName: "Beta Model" }),
    });
    await app.inject({ headers: ADMIN, method: "DELETE", url: `/v1/models/${modelA.id}` });

    const byVendor = await app.inject({ headers: ADMIN, method: "GET", url: `/v1/models?vendorId=${vendorA.id}` });
    assert.equal(byVendor.json().models.length, 1);
    assert.equal(byVendor.json().models[0].vendorId, vendorA.id);

    const byStatus = await app.inject({ headers: ADMIN, method: "GET", url: "/v1/models?status=disabled" });
    assert.equal(byStatus.json().models.length, 1);
    assert.equal(byStatus.json().models[0].inhouseAlias, "alpha-model");

    const bySearch = await app.inject({ headers: ADMIN, method: "GET", url: "/v1/models?search=beta" });
    assert.equal(bySearch.json().models.length, 1);
    assert.equal(bySearch.json().models[0].inhouseAlias, "beta-model");
  });
});

test("GET /v1/models supports pagination via limit/offset", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendor = await createVendor(app);
    for (let i = 0; i < 5; i += 1) {
      await app.inject({ headers: ADMIN,
        method: "POST",
        url: "/v1/models",
        payload: sampleModelPayload(vendor.id, {
          inhouseAlias: `model-${i}`,
          providerModelId: `provider-${i}`,
        }),
      });
    }

    const page1 = await app.inject({ headers: ADMIN, method: "GET", url: "/v1/models?limit=2&offset=0" });
    assert.equal(page1.json().models.length, 2);
    const page2 = await app.inject({ headers: ADMIN, method: "GET", url: "/v1/models?limit=2&offset=2" });
    assert.equal(page2.json().models.length, 2);
    assert.notDeepEqual(page1.json().models, page2.json().models);

    const invalidLimit = await app.inject({ headers: ADMIN, method: "GET", url: "/v1/models?limit=0" });
    assert.equal(invalidLimit.statusCode, 400);
  });
});

test("GET /v1/models filters by capability and workload", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const capabilities = new CapabilitiesRepository(pool);
    const workloads = new WorkloadsRepository(pool);
    const streaming = await capabilities.create({ slug: "streaming", display_name: "Streaming", description: null });
    const vision = await capabilities.create({ slug: "vision", display_name: "Vision", description: null });
    const coding = await workloads.create({
      slug: "coding_agent",
      display_name: "Coding Agent",
      description: null,
      status: "enabled",
    });

    const vendor = await createVendor(app);
    const modelWithStreaming = (
      await app.inject({ headers: ADMIN,
        method: "POST",
        url: "/v1/models",
        payload: sampleModelPayload(vendor.id, {
          inhouseAlias: "streaming-model",
          capabilityIds: [streaming.id],
          workloadIds: [coding.id],
        }),
      })
    ).json().model;
    await app.inject({ headers: ADMIN,
      method: "POST",
      url: "/v1/models",
      payload: sampleModelPayload(vendor.id, {
        inhouseAlias: "vision-model",
        providerModelId: "provider-vision",
        capabilityIds: [vision.id],
      }),
    });

    const byCapability = await app.inject({ headers: ADMIN, method: "GET", url: `/v1/models?capabilityId=${streaming.id}` });
    assert.equal(byCapability.json().models.length, 1);
    assert.equal(byCapability.json().models[0].id, modelWithStreaming.id);

    const byWorkload = await app.inject({ headers: ADMIN, method: "GET", url: `/v1/models?workloadId=${coding.id}` });
    assert.equal(byWorkload.json().models.length, 1);
    assert.equal(byWorkload.json().models[0].id, modelWithStreaming.id);
  });
});

test("model capability and workload assignment persists and is replaceable", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const capabilities = new CapabilitiesRepository(pool);
    const workloads = new WorkloadsRepository(pool);
    const streaming = await capabilities.create({ slug: "streaming", display_name: "Streaming", description: null });
    const vision = await capabilities.create({ slug: "vision", display_name: "Vision", description: null });
    const coding = await workloads.create({
      slug: "coding_agent",
      display_name: "Coding Agent",
      description: null,
      status: "enabled",
    });

    const vendor = await createVendor(app);
    const model = (
      await app.inject({ headers: ADMIN,
        method: "POST",
        url: "/v1/models",
        payload: sampleModelPayload(vendor.id, { capabilityIds: [streaming.id], workloadIds: [coding.id] }),
      })
    ).json().model;
    assert.equal(model.capabilities.length, 1);
    assert.equal(model.capabilities[0].slug, "streaming");

    const replaceRes = await app.inject({ headers: ADMIN,
      method: "PUT",
      url: `/v1/models/${model.id}/capabilities`,
      payload: { capabilityIds: [vision.id] },
    });
    assert.equal(replaceRes.statusCode, 200);
    assert.equal(replaceRes.json().capabilities.length, 1);
    assert.equal(replaceRes.json().capabilities[0].slug, "vision");

    const removeRes = await app.inject({ headers: ADMIN,
      method: "PUT",
      url: `/v1/models/${model.id}/workloads`,
      payload: { workloadIds: [] },
    });
    assert.equal(removeRes.statusCode, 200);
    assert.deepEqual(removeRes.json().workloads, []);
  });
});

test("assigning a duplicate capability id in one call is deduplicated, not an error", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const capabilities = new CapabilitiesRepository(pool);
    const streaming = await capabilities.create({ slug: "streaming", display_name: "Streaming", description: null });
    const vendor = await createVendor(app);
    const model = (
      await app.inject({ headers: ADMIN, method: "POST", url: "/v1/models", payload: sampleModelPayload(vendor.id) })
    ).json().model;

    const res = await app.inject({ headers: ADMIN,
      method: "PUT",
      url: `/v1/models/${model.id}/capabilities`,
      payload: { capabilityIds: [streaming.id, streaming.id] },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().capabilities.length, 1);
  });
});

test("assigning capabilities to a nonexistent model returns 404, not a 500", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const capabilities = new CapabilitiesRepository(pool);
    const streaming = await capabilities.create({ slug: "streaming", display_name: "Streaming", description: null });

    const res = await app.inject({ headers: ADMIN,
      method: "PUT",
      url: `/v1/models/${MISSING_ID}/capabilities`,
      payload: { capabilityIds: [streaming.id] },
    });
    assert.equal(res.statusCode, 404);
  });
});

test("assigning a nonexistent capability id to a model returns a clean structured error, not a 500", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const capabilities = new CapabilitiesRepository(pool);
    const streaming = await capabilities.create({ slug: "streaming", display_name: "Streaming", description: null });
    const vendor = await createVendor(app);
    const model = (
      await app.inject({ headers: ADMIN,
        method: "POST",
        url: "/v1/models",
        payload: sampleModelPayload(vendor.id, { capabilityIds: [streaming.id] }),
      })
    ).json().model;

    const res = await app.inject({ headers: ADMIN,
      method: "PUT",
      url: `/v1/models/${model.id}/capabilities`,
      payload: { capabilityIds: [MISSING_ID] },
    });
    assert.ok(res.statusCode === 400 || res.statusCode === 404, `expected 400/404, got ${res.statusCode}`);
    assert.ok(!res.body.includes("relation"));
    assert.ok(!res.body.includes("constraint"));

    const unchanged = await app.inject({ headers: ADMIN, method: "GET", url: `/v1/models/${model.id}` });
    assert.equal(unchanged.json().model.capabilities.length, 1);
    assert.equal(unchanged.json().model.capabilities[0].slug, "streaming");
  });
});

test("a mixed valid+nonexistent capability id list for a model fails atomically", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const capabilities = new CapabilitiesRepository(pool);
    const streaming = await capabilities.create({ slug: "streaming", display_name: "Streaming", description: null });
    const vision = await capabilities.create({ slug: "vision", display_name: "Vision", description: null });
    const vendor = await createVendor(app);
    const model = (
      await app.inject({ headers: ADMIN,
        method: "POST",
        url: "/v1/models",
        payload: sampleModelPayload(vendor.id, { capabilityIds: [streaming.id] }),
      })
    ).json().model;

    const res = await app.inject({ headers: ADMIN,
      method: "PUT",
      url: `/v1/models/${model.id}/capabilities`,
      payload: { capabilityIds: [vision.id, MISSING_ID] },
    });
    assert.ok(res.statusCode === 400 || res.statusCode === 404);

    const unchanged = await app.inject({ headers: ADMIN, method: "GET", url: `/v1/models/${model.id}` });
    const slugs = unchanged.json().model.capabilities.map((c: { slug: string }) => c.slug);
    assert.deepEqual(slugs, ["streaming"]);
  });
});

test("a mixed valid+nonexistent workload id list for a model fails atomically", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workloads = new WorkloadsRepository(pool);
    const coding = await workloads.create({
      slug: "coding_agent",
      display_name: "Coding Agent",
      description: null,
      status: "enabled",
    });
    const research = await workloads.create({
      slug: "research",
      display_name: "Research",
      description: null,
      status: "enabled",
    });
    const vendor = await createVendor(app);
    const model = (
      await app.inject({ headers: ADMIN,
        method: "POST",
        url: "/v1/models",
        payload: sampleModelPayload(vendor.id, { workloadIds: [coding.id] }),
      })
    ).json().model;

    const res = await app.inject({ headers: ADMIN,
      method: "PUT",
      url: `/v1/models/${model.id}/workloads`,
      payload: { workloadIds: [research.id, MISSING_ID] },
    });
    assert.ok(res.statusCode === 400 || res.statusCode === 404);

    const unchanged = await app.inject({ headers: ADMIN, method: "GET", url: `/v1/models/${model.id}` });
    const slugs = unchanged.json().model.workloads.map((w: { slug: string }) => w.slug);
    assert.deepEqual(slugs, ["coding_agent"]);
  });
});

test("creating a model with a nonexistent capability id in the inline list fails without creating the model", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendor = await createVendor(app);

    const res = await app.inject({ headers: ADMIN,
      method: "POST",
      url: "/v1/models",
      payload: sampleModelPayload(vendor.id, { capabilityIds: [MISSING_ID] }),
    });
    assert.ok(res.statusCode === 400 || res.statusCode === 404);

    const list = await app.inject({ headers: ADMIN, method: "GET", url: "/v1/models" });
    assert.equal(list.json().models.length, 0, "no model should have been created");
  });
});

test("a SQL-injection-shaped search value is treated as inert data via parameterized queries", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendor = await createVendor(app);
    await app.inject({ headers: ADMIN, method: "POST", url: "/v1/models", payload: sampleModelPayload(vendor.id) });

    const res = await app.inject({ headers: ADMIN,
      method: "GET",
      url: `/v1/models?search=${encodeURIComponent("'; DROP TABLE models; --")}`,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().models, []);

    const stillThere = await pool.query("SELECT count(*)::int AS n FROM models");
    assert.equal(stillThere.rows[0].n, 1);
  });
});

test("audit events are recorded for model lifecycle and assignment actions", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendor = await createVendor(app);
    const model = (
      await app.inject({ headers: ADMIN, method: "POST", url: "/v1/models", payload: sampleModelPayload(vendor.id) })
    ).json().model;
    await app.inject({ headers: ADMIN, method: "PATCH", url: `/v1/models/${model.id}`, payload: { displayName: "Renamed" } });
    await app.inject({ headers: ADMIN, method: "DELETE", url: `/v1/models/${model.id}` });

    const events = await pool.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE resource_type = 'model' AND resource_id = $1 ORDER BY created_at",
      [model.id],
    );
    const actions = events.rows.map((r) => r.action);
    assert.ok(actions.includes("model.created"));
    assert.ok(actions.includes("model.updated"));
    assert.ok(actions.includes("model.disabled"));
  });
});
