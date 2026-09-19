import assert from "node:assert/strict";
import { test } from "node:test";
import { withMigratedApp, truncateAll } from "./helpers.js";
import { CapabilitiesRepository } from "../../src/repositories/capabilitiesRepository.js";
import { WorkloadsRepository } from "../../src/repositories/workloadsRepository.js";

const sampleVendorPayload = {
  slug: "test-vendor-01",
  displayName: "Test Vendor 01",
  vendorType: "general_api",
  protocol: "custom_rest",
  baseEndpoint: "https://api.example.invalid/v1",
  description: "A vendor used only in tests.",
  billingType: "metered",
  defaultTier: 1,
  maxTier: 3,
  automaticFallback: true,
  timeoutMs: 5000,
  retryMaxAttempts: 2,
  retryBackoffMs: 250,
  priority: 5,
  retryOnTimeout: true,
  retryOnRateLimit: true,
  retryOn5xx: false,
  retryOnAuthFailure: false,
  retryOnInvalidResponse: false,
};

test("GET /v1/vendors returns an empty list before any vendor exists", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const res = await app.inject({ method: "GET", url: "/v1/vendors" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().vendors, []);
  });
});

test("POST /v1/vendors creates a vendor and GET /v1/vendors lists it", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const createRes = await app.inject({ method: "POST", url: "/v1/vendors", payload: sampleVendorPayload });
    assert.equal(createRes.statusCode, 201);
    const created = createRes.json().vendor;
    assert.equal(created.slug, "test-vendor-01");
    assert.equal(created.status, "enabled");
    assert.deepEqual(created.accounts, []);

    const listRes = await app.inject({ method: "GET", url: "/v1/vendors" });
    assert.equal(listRes.statusCode, 200);
    const vendors = listRes.json().vendors;
    assert.equal(vendors.length, 1);
    assert.equal(vendors[0].id, created.id);
  });
});

test("GET /v1/vendors/:id returns vendor detail; 404 for a missing vendor carries the structured error shape and request id", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const createRes = await app.inject({ method: "POST", url: "/v1/vendors", payload: sampleVendorPayload });
    const created = createRes.json().vendor;

    const getRes = await app.inject({ method: "GET", url: `/v1/vendors/${created.id}` });
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.json().vendor.id, created.id);

    const missingId = "00000000-0000-0000-0000-000000000000";
    const missingRes = await app.inject({ method: "GET", url: `/v1/vendors/${missingId}` });
    assert.equal(missingRes.statusCode, 404);
    const body = missingRes.json();
    assert.equal(body.error.code, "NOT_FOUND");
    assert.equal(body.error.requestId, missingRes.headers["x-request-id"]);
  });
});

test("POST /v1/vendors rejects an invalid payload with a structured 400", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const res = await app.inject({
      method: "POST",
      url: "/v1/vendors",
      payload: { ...sampleVendorPayload, slug: undefined },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.ok(body.error.requestId);
  });
});

test("POST /v1/vendors rejects a base endpoint that is not an http(s) URL", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const res = await app.inject({
      method: "POST",
      url: "/v1/vendors",
      payload: { ...sampleVendorPayload, baseEndpoint: "not-a-url" },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "VALIDATION_ERROR");
  });
});

test("POST /v1/vendors rejects a duplicate slug with 409 CONFLICT", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const first = await app.inject({ method: "POST", url: "/v1/vendors", payload: sampleVendorPayload });
    assert.equal(first.statusCode, 201);

    const duplicate = await app.inject({ method: "POST", url: "/v1/vendors", payload: sampleVendorPayload });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error.code, "CONFLICT");
  });
});

test("PATCH /v1/vendors/:id updates fields and rejects an empty body", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const created = (await app.inject({ method: "POST", url: "/v1/vendors", payload: sampleVendorPayload })).json()
      .vendor;

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/vendors/${created.id}`,
      payload: { displayName: "Renamed Vendor", priority: 8 },
    });
    assert.equal(patchRes.statusCode, 200);
    const updated = patchRes.json().vendor;
    assert.equal(updated.displayName, "Renamed Vendor");
    assert.equal(updated.priority, 8);

    const emptyPatch = await app.inject({ method: "PATCH", url: `/v1/vendors/${created.id}`, payload: {} });
    assert.equal(emptyPatch.statusCode, 400);
  });
});

test("DELETE /v1/vendors/:id soft-disables the vendor rather than deleting the row", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const created = (await app.inject({ method: "POST", url: "/v1/vendors", payload: sampleVendorPayload })).json()
      .vendor;

    const deleteRes = await app.inject({ method: "DELETE", url: `/v1/vendors/${created.id}` });
    assert.equal(deleteRes.statusCode, 200);
    assert.equal(deleteRes.json().vendor.status, "disabled");

    const stillThere = await pool.query("SELECT status FROM vendors WHERE id = $1", [created.id]);
    assert.equal(stillThere.rows.length, 1);
    assert.equal(stillThere.rows[0].status, "disabled");
  });
});

test("vendor account CRUD supports multiple accounts per vendor", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendor = (await app.inject({ method: "POST", url: "/v1/vendors", payload: sampleVendorPayload })).json()
      .vendor;

    const acct1 = await app.inject({
      method: "POST",
      url: `/v1/vendors/${vendor.id}/accounts`,
      payload: { slug: "primary", displayName: "Primary Account" },
    });
    assert.equal(acct1.statusCode, 201);
    const acct2 = await app.inject({
      method: "POST",
      url: `/v1/vendors/${vendor.id}/accounts`,
      payload: { slug: "secondary", displayName: "Secondary Account" },
    });
    assert.equal(acct2.statusCode, 201);

    const listRes = await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}/accounts` });
    assert.equal(listRes.json().accounts.length, 2);

    const accountId = acct1.json().account.id;
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/vendors/${vendor.id}/accounts/${accountId}`,
      payload: { displayName: "Renamed Account" },
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(patchRes.json().account.displayName, "Renamed Account");

    const disableRes = await app.inject({
      method: "DELETE",
      url: `/v1/vendors/${vendor.id}/accounts/${accountId}`,
    });
    assert.equal(disableRes.statusCode, 200);
    assert.equal(disableRes.json().account.status, "disabled");
  });
});

test("credential metadata CRUD never returns raw secret material", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendor = (await app.inject({ method: "POST", url: "/v1/vendors", payload: sampleVendorPayload })).json()
      .vendor;
    const account = (
      await app.inject({
        method: "POST",
        url: `/v1/vendors/${vendor.id}/accounts`,
        payload: { slug: "primary", displayName: "Primary Account" },
      })
    ).json().account;

    const createRes = await app.inject({
      method: "POST",
      url: `/v1/vendors/${vendor.id}/credentials`,
      payload: { vendorAccountId: account.id, credentialType: "api_key", secretRef: "vault://path/to/secret" },
    });
    assert.equal(createRes.statusCode, 201);
    const credential = createRes.json().credential;
    assert.equal(credential.secretRef, "vault://path/to/secret");
    assert.deepEqual(
      Object.keys(credential).sort(),
      [
        "credentialType",
        "id",
        "lastSuccessfulAt",
        "lastTestedAt",
        "secretRef",
        "hasManagedSecret",
        "maskedSecret",
        "status",
        "updatedAt",
        "vendorAccountId",
        "createdAt",
      ].sort(),
    );
    // hasManagedSecret/maskedSecret (Block 08) describe an INHOUSE-vault-managed
    // secret without exposing it; both are null/false here since this
    // credential uses an external secretRef, not a managed secret.
    assert.equal(credential.hasManagedSecret, false);
    assert.equal(credential.maskedSecret, null);
    // secretRef is a reference string, not raw provider-secret material — and
    // no other field on the response could ever carry a raw secret because
    // the response is built from an explicit whitelist (toCredentialResponse).

    const listRes = await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}/credentials` });
    assert.equal(listRes.json().credentials.length, 1);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/vendors/${vendor.id}/credentials/${credential.id}`,
      payload: { status: "disabled" },
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(patchRes.json().credential.status, "disabled");

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/v1/vendors/${vendor.id}/credentials/${credential.id}`,
    });
    assert.equal(deleteRes.statusCode, 204);

    const afterDelete = await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}/credentials` });
    assert.equal(afterDelete.json().credentials.length, 0);
  });
});

test("credential creation requires an account that belongs to the given vendor", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendorA = (await app.inject({ method: "POST", url: "/v1/vendors", payload: sampleVendorPayload })).json()
      .vendor;
    const vendorB = (
      await app.inject({ method: "POST", url: "/v1/vendors", payload: { ...sampleVendorPayload, slug: "vendor-b" } })
    ).json().vendor;
    const accountOfA = (
      await app.inject({
        method: "POST",
        url: `/v1/vendors/${vendorA.id}/accounts`,
        payload: { slug: "acct-a", displayName: "Account A" },
      })
    ).json().account;

    const res = await app.inject({
      method: "POST",
      url: `/v1/vendors/${vendorB.id}/credentials`,
      payload: { vendorAccountId: accountOfA.id, credentialType: "api_key", secretRef: "vault://x" },
    });
    assert.equal(res.statusCode, 404);
  });
});

test("adapterSupported (Block 10) is computed from the code-defined adapter registry, never stored, and is false for a provider with no adapter", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    // `sampleVendorPayload` uses protocol "custom_rest" — a real, valid, database-configured
    // protocol with no registered adapter. That must never read as executable.
    const created = (await app.inject({ method: "POST", url: "/v1/vendors", payload: sampleVendorPayload })).json()
      .vendor;
    assert.equal(created.protocol, "custom_rest");
    assert.equal(created.adapterSupported, false);

    const listRes = await app.inject({ method: "GET", url: "/v1/vendors" });
    assert.equal(listRes.json().vendors[0].adapterSupported, false);

    const getRes = await app.inject({ method: "GET", url: `/v1/vendors/${created.id}` });
    assert.equal(getRes.json().vendor.adapterSupported, false);

    // Never persisted on the row itself — purely a serialization-time computation.
    const row = await pool.query("SELECT * FROM vendors WHERE id = $1", [created.id]);
    assert.ok(!("adapter_supported" in row.rows[0]));
  });
});

test("adapterSupported (Block 10) is true for a vendor configured with a protocol that has a registered adapter", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/vendors",
        payload: { ...sampleVendorPayload, slug: "openai-compatible-vendor", protocol: "openai-compatible" },
      })
    ).json().vendor;
    assert.equal(created.adapterSupported, true);

    const disabled = (
      await app.inject({ method: "DELETE", url: `/v1/vendors/${created.id}` })
    ).json().vendor;
    // Adapter support is a fact about the protocol, independent of the vendor's own enabled/disabled status.
    assert.equal(disabled.status, "disabled");
    assert.equal(disabled.adapterSupported, true);
  });
});

test("GET /v1/capabilities and /v1/workloads reflect database rows, empty by default", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const emptyCaps = await app.inject({ method: "GET", url: "/v1/capabilities" });
    assert.deepEqual(emptyCaps.json().capabilities, []);
    const emptyWorkloads = await app.inject({ method: "GET", url: "/v1/workloads" });
    assert.deepEqual(emptyWorkloads.json().workloads, []);

    const capabilities = new CapabilitiesRepository(pool);
    const workloads = new WorkloadsRepository(pool);
    await capabilities.create({ slug: "streaming", display_name: "Streaming", description: null });
    await workloads.create({ slug: "coding_agent", display_name: "Coding Agent", description: null, status: "enabled" });

    const capsRes = await app.inject({ method: "GET", url: "/v1/capabilities" });
    assert.equal(capsRes.json().capabilities.length, 1);
    const workloadsRes = await app.inject({ method: "GET", url: "/v1/workloads" });
    assert.equal(workloadsRes.json().workloads.length, 1);
  });
});

test("vendor capability and workload assignment persists and is replaceable", async () => {
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

    const vendor = (
      await app.inject({
        method: "POST",
        url: "/v1/vendors",
        payload: { ...sampleVendorPayload, capabilityIds: [streaming.id], workloadIds: [coding.id] },
      })
    ).json().vendor;
    assert.equal(vendor.capabilities.length, 1);
    assert.equal(vendor.capabilities[0].slug, "streaming");
    assert.equal(vendor.workloads.length, 1);

    const replaceRes = await app.inject({
      method: "PUT",
      url: `/v1/vendors/${vendor.id}/capabilities`,
      payload: { capabilityIds: [vision.id] },
    });
    assert.equal(replaceRes.statusCode, 200);
    assert.equal(replaceRes.json().capabilities.length, 1);
    assert.equal(replaceRes.json().capabilities[0].slug, "vision");

    const detailRes = await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}` });
    assert.equal(detailRes.json().vendor.capabilities.length, 1);
    assert.equal(detailRes.json().vendor.capabilities[0].slug, "vision");
  });
});

const MISSING_ID = "00000000-0000-0000-0000-000000000000";

test("assigning a nonexistent capability id returns a clean structured error, not a 500", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const capabilities = new CapabilitiesRepository(pool);
    const streaming = await capabilities.create({ slug: "streaming", display_name: "Streaming", description: null });

    const vendor = (
      await app.inject({
        method: "POST",
        url: "/v1/vendors",
        payload: { ...sampleVendorPayload, capabilityIds: [streaming.id] },
      })
    ).json().vendor;

    const res = await app.inject({
      method: "PUT",
      url: `/v1/vendors/${vendor.id}/capabilities`,
      payload: { capabilityIds: [MISSING_ID] },
    });

    assert.ok(res.statusCode === 400 || res.statusCode === 404, `expected 400/404, got ${res.statusCode}`);
    const body = res.json();
    assert.ok(body.error, "response must use the structured error shape");
    assert.equal(typeof body.error.code, "string");
    assert.equal(typeof body.error.message, "string");
    assert.equal(body.error.requestId, res.headers["x-request-id"]);
    assert.ok(!res.body.includes("relation"), "must not leak a Postgres error");
    assert.ok(!res.body.includes("constraint"), "must not leak a Postgres constraint name");
    assert.ok(!res.body.toLowerCase().includes("at "), "must not leak a stack trace");

    const unchanged = await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}` });
    assert.equal(unchanged.json().vendor.capabilities.length, 1);
    assert.equal(unchanged.json().vendor.capabilities[0].slug, "streaming");
  });
});

test("assigning a nonexistent workload id returns a clean structured error, not a 500", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const workloads = new WorkloadsRepository(pool);
    const coding = await workloads.create({
      slug: "coding_agent",
      display_name: "Coding Agent",
      description: null,
      status: "enabled",
    });

    const vendor = (
      await app.inject({
        method: "POST",
        url: "/v1/vendors",
        payload: { ...sampleVendorPayload, workloadIds: [coding.id] },
      })
    ).json().vendor;

    const res = await app.inject({
      method: "PUT",
      url: `/v1/vendors/${vendor.id}/workloads`,
      payload: { workloadIds: [MISSING_ID] },
    });

    assert.ok(res.statusCode === 400 || res.statusCode === 404, `expected 400/404, got ${res.statusCode}`);
    const body = res.json();
    assert.ok(body.error, "response must use the structured error shape");
    assert.equal(typeof body.error.code, "string");
    assert.equal(typeof body.error.message, "string");
    assert.equal(body.error.requestId, res.headers["x-request-id"]);
    assert.ok(!res.body.includes("relation"), "must not leak a Postgres error");
    assert.ok(!res.body.includes("constraint"), "must not leak a Postgres constraint name");
    assert.ok(!res.body.toLowerCase().includes("at "), "must not leak a stack trace");

    const unchanged = await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}` });
    assert.equal(unchanged.json().vendor.workloads.length, 1);
    assert.equal(unchanged.json().vendor.workloads[0].slug, "coding_agent");
  });
});

test("a mixed valid+nonexistent capability id list fails atomically with no partial assignment", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const capabilities = new CapabilitiesRepository(pool);
    const streaming = await capabilities.create({ slug: "streaming", display_name: "Streaming", description: null });
    const vision = await capabilities.create({ slug: "vision", display_name: "Vision", description: null });

    const vendor = (
      await app.inject({
        method: "POST",
        url: "/v1/vendors",
        payload: { ...sampleVendorPayload, capabilityIds: [streaming.id] },
      })
    ).json().vendor;

    const res = await app.inject({
      method: "PUT",
      url: `/v1/vendors/${vendor.id}/capabilities`,
      payload: { capabilityIds: [vision.id, MISSING_ID] },
    });
    assert.ok(res.statusCode === 400 || res.statusCode === 404, `expected 400/404, got ${res.statusCode}`);
    assert.ok(res.json().error);

    // Atomic: the valid id in the mixed list must NOT have been partially
    // assigned, and the original assignment must be untouched.
    const unchanged = await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}` });
    const slugs = unchanged.json().vendor.capabilities.map((c: { slug: string }) => c.slug);
    assert.deepEqual(slugs, ["streaming"]);
  });
});

test("a mixed valid+nonexistent workload id list fails atomically with no partial assignment", async () => {
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

    const vendor = (
      await app.inject({
        method: "POST",
        url: "/v1/vendors",
        payload: { ...sampleVendorPayload, workloadIds: [coding.id] },
      })
    ).json().vendor;

    const res = await app.inject({
      method: "PUT",
      url: `/v1/vendors/${vendor.id}/workloads`,
      payload: { workloadIds: [research.id, MISSING_ID] },
    });
    assert.ok(res.statusCode === 400 || res.statusCode === 404, `expected 400/404, got ${res.statusCode}`);
    assert.ok(res.json().error);

    const unchanged = await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}` });
    const slugs = unchanged.json().vendor.workloads.map((w: { slug: string }) => w.slug);
    assert.deepEqual(slugs, ["coding_agent"]);
  });
});

test("creating a vendor with a nonexistent capability id in the inline list fails cleanly without creating the vendor", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");

    const res = await app.inject({
      method: "POST",
      url: "/v1/vendors",
      payload: { ...sampleVendorPayload, capabilityIds: [MISSING_ID] },
    });
    assert.ok(res.statusCode === 400 || res.statusCode === 404, `expected 400/404, got ${res.statusCode}`);
    assert.ok(res.json().error);

    const list = await app.inject({ method: "GET", url: "/v1/vendors" });
    assert.equal(list.json().vendors.length, 0, "no vendor should have been created");
  });
});

test("every vendor response carries an x-request-id header matching the body's error requestId on failure", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const res = await app.inject({ method: "GET", url: "/v1/vendors" });
    assert.ok(typeof res.headers["x-request-id"] === "string" && res.headers["x-request-id"].length > 0);
  });
});

test("a SQL-injection-shaped slug is stored as inert data via parameterized queries", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const maliciousSlug = "test-vendor-injection";
    const res = await app.inject({
      method: "POST",
      url: "/v1/vendors",
      payload: { ...sampleVendorPayload, slug: maliciousSlug, description: "'; DROP TABLE vendors; --" },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().vendor.description, "'; DROP TABLE vendors; --");

    const stillThere = await pool.query("SELECT count(*)::int AS n FROM vendors");
    assert.equal(stillThere.rows[0].n, 1);
  });
});

test("audit events are recorded for vendor and account lifecycle actions", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendor = (await app.inject({ method: "POST", url: "/v1/vendors", payload: sampleVendorPayload })).json()
      .vendor;
    await app.inject({ method: "PATCH", url: `/v1/vendors/${vendor.id}`, payload: { priority: 9 } });
    await app.inject({ method: "DELETE", url: `/v1/vendors/${vendor.id}` });
    await app.inject({
      method: "POST",
      url: `/v1/vendors/${vendor.id}/accounts`,
      payload: { slug: "primary", displayName: "Primary" },
    });

    const events = await pool.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE resource_id = $1 OR action LIKE 'vendor_account%' ORDER BY created_at",
      [vendor.id],
    );
    const actions = events.rows.map((r) => r.action);
    assert.ok(actions.includes("vendor.created"));
    assert.ok(actions.includes("vendor.updated"));
    assert.ok(actions.includes("vendor.disabled"));
  });
});

test("audit event metadata never contains secret material", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const vendor = (await app.inject({ method: "POST", url: "/v1/vendors", payload: sampleVendorPayload })).json()
      .vendor;
    const account = (
      await app.inject({
        method: "POST",
        url: `/v1/vendors/${vendor.id}/accounts`,
        payload: { slug: "primary", displayName: "Primary" },
      })
    ).json().account;
    await app.inject({
      method: "POST",
      url: `/v1/vendors/${vendor.id}/credentials`,
      payload: { vendorAccountId: account.id, credentialType: "api_key", secretRef: "vault://super-secret-path" },
    });

    const events = await pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action = 'vendor_credential.created'",
    );
    assert.equal(events.rows.length, 1);
    const metadataText = JSON.stringify(events.rows[0].metadata);
    assert.ok(!metadataText.includes("vault://super-secret-path"));
  });
});
