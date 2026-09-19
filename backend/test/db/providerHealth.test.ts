import assert from "node:assert/strict";
import { test } from "node:test";
import { withMigratedApp, truncateAll } from "./helpers.js";
import { ProviderHealthService } from "../../src/services/providerHealthService.js";
import { NotFoundError } from "../../src/lib/httpErrors.js";

const sampleVendorPayload = {
  slug: "health-audit-vendor",
  displayName: "Health Audit Vendor",
  vendorType: "general_api",
  protocol: "custom_rest",
  baseEndpoint: "https://api.example.invalid/v1",
  billingType: "metered",
};

async function createVendorWithAccount(app: import("fastify").FastifyInstance, accountOverrides: Record<string, unknown> = {}) {
  const vendor = (await app.inject({ method: "POST", url: "/v1/vendors", payload: sampleVendorPayload })).json().vendor;
  const account = (
    await app.inject({
      method: "POST",
      url: `/v1/vendors/${vendor.id}/accounts`,
      payload: { slug: "primary", displayName: "Primary Account", ...accountOverrides },
    })
  ).json().account;
  return { vendor, account };
}

const MISSING_ID = "00000000-0000-0000-0000-000000000000";

test("malformed (non-UUID) vendor or account ids are rejected with 400, not a 500", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);

    const badVendor = await app.inject({
      method: "GET",
      url: `/v1/vendors/not-a-uuid/accounts/${account.id}/health`,
    });
    assert.equal(badVendor.statusCode, 400);

    const badAccount = await app.inject({
      method: "GET",
      url: `/v1/vendors/${vendor.id}/accounts/not-a-uuid/health`,
    });
    assert.equal(badAccount.statusCode, 400);

    const badEvents = await app.inject({
      method: "GET",
      url: `/v1/vendors/${vendor.id}/accounts/not-a-uuid/health/events`,
    });
    assert.equal(badEvents.statusCode, 400);
  });
});

test("GET health returns 'unknown' before any observation has been recorded", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);

    const res = await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}/accounts/${account.id}/health` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().health, {
      vendorAccountId: account.id,
      status: "unknown",
      consecutiveFailures: 0,
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastLatencyMs: null,
      lastErrorCategory: null,
      lastSafeErrorCode: null,
    });

    const eventsRes = await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}/accounts/${account.id}/health/events` });
    assert.equal(eventsRes.statusCode, 200);
    assert.deepEqual(eventsRes.json().events, []);
  });
});

test("recording a healthy observation creates a snapshot and one history event, safely serialized", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);
    const service = new ProviderHealthService(pool);

    await service.recordObservation(vendor.id, account.id, {
      status: "healthy",
      latencyMs: 250,
      errorCategory: null,
      safeErrorCode: null,
      source: "manual",
      checkedAt: new Date(),
    });

    const healthRes = await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}/accounts/${account.id}/health` });
    const health = healthRes.json().health;
    assert.equal(health.status, "healthy");
    assert.equal(health.consecutiveFailures, 0);
    assert.equal(health.lastLatencyMs, 250);
    assert.ok(health.lastCheckedAt);
    assert.ok(health.lastSuccessAt);
    assert.equal(health.lastFailureAt, null);
    assert.deepEqual(
      Object.keys(health).sort(),
      [
        "vendorAccountId",
        "status",
        "consecutiveFailures",
        "lastCheckedAt",
        "lastSuccessAt",
        "lastFailureAt",
        "lastLatencyMs",
        "lastErrorCategory",
        "lastSafeErrorCode",
      ].sort(),
    );

    const eventsRes = await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}/accounts/${account.id}/health/events` });
    const events = eventsRes.json().events;
    assert.equal(events.length, 1);
    assert.equal(events[0].status, "healthy");
    assert.equal(events[0].source, "manual");
    assert.deepEqual(
      Object.keys(events[0]).sort(),
      ["id", "vendorAccountId", "status", "latencyMs", "errorCategory", "safeErrorCode", "source", "checkedAt", "createdAt"].sort(),
    );
  });
});

test("consecutive failures increment across repeated unhealthy observations and reset on a healthy one", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);
    const service = new ProviderHealthService(pool);

    for (let i = 0; i < 3; i++) {
      await service.recordObservation(vendor.id, account.id, {
        status: "unhealthy",
        latencyMs: null,
        errorCategory: "timeout",
        safeErrorCode: "ETIMEDOUT",
        source: "manual",
        checkedAt: new Date(),
      });
    }
    const afterThreeFailures = await service.getCurrentHealth(vendor.id, account.id);
    assert.equal(afterThreeFailures?.consecutive_failures, 3);
    assert.equal(afterThreeFailures?.status, "unhealthy");

    await service.recordObservation(vendor.id, account.id, {
      status: "healthy",
      latencyMs: 90,
      errorCategory: null,
      safeErrorCode: null,
      source: "manual",
      checkedAt: new Date(),
    });
    const afterRecovery = await service.getCurrentHealth(vendor.id, account.id);
    assert.equal(afterRecovery?.consecutive_failures, 0);
    assert.equal(afterRecovery?.status, "healthy");
    // last_failure_at is retained as history even after recovering.
    assert.ok(afterRecovery?.last_failure_at);

    const history = await service.getHistory(vendor.id, account.id, 50);
    assert.equal(history.length, 4);
  });
});

test("every named state transition produces deterministic status/consecutive_failures — unknown, healthy, degraded, unhealthy in every order", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);
    const service = new ProviderHealthService(pool);

    async function observe(status: "healthy" | "degraded" | "unhealthy") {
      await service.recordObservation(vendor.id, account.id, {
        status,
        latencyMs: status === "healthy" ? 50 : null,
        errorCategory: status === "healthy" ? null : "provider_error",
        safeErrorCode: status === "healthy" ? null : "500",
        source: "manual",
        checkedAt: new Date(),
      });
      return service.getCurrentHealth(vendor.id, account.id);
    }

    // unknown -> degraded
    let current = await observe("degraded");
    assert.equal(current?.status, "degraded");
    assert.equal(current?.consecutive_failures, 0);

    // degraded -> unhealthy
    current = await observe("unhealthy");
    assert.equal(current?.status, "unhealthy");
    assert.equal(current?.consecutive_failures, 1);

    // unhealthy -> unhealthy
    current = await observe("unhealthy");
    assert.equal(current?.status, "unhealthy");
    assert.equal(current?.consecutive_failures, 2);

    // unhealthy -> degraded
    current = await observe("degraded");
    assert.equal(current?.status, "degraded");
    assert.equal(current?.consecutive_failures, 0);

    // degraded -> healthy
    current = await observe("healthy");
    assert.equal(current?.status, "healthy");
    assert.equal(current?.consecutive_failures, 0);

    // healthy -> unhealthy
    current = await observe("unhealthy");
    assert.equal(current?.status, "unhealthy");
    assert.equal(current?.consecutive_failures, 1);

    // unhealthy -> healthy
    current = await observe("healthy");
    assert.equal(current?.status, "healthy");
    assert.equal(current?.consecutive_failures, 0);

    // healthy -> degraded
    current = await observe("degraded");
    assert.equal(current?.status, "degraded");
    assert.equal(current?.consecutive_failures, 0);
  });
});

test("a fresh (never-observed) account starts unknown, and unknown -> unhealthy increments from zero", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);
    const service = new ProviderHealthService(pool);

    assert.equal(await service.getCurrentHealth(vendor.id, account.id), null);

    await service.recordObservation(vendor.id, account.id, {
      status: "unhealthy",
      latencyMs: null,
      errorCategory: "network",
      safeErrorCode: "ECONNREFUSED",
      source: "manual",
      checkedAt: new Date(),
    });
    const current = await service.getCurrentHealth(vendor.id, account.id);
    assert.equal(current?.status, "unhealthy");
    assert.equal(current?.consecutive_failures, 1);
  });
});

test("a degraded observation resets consecutive failures the same as a healthy one", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);
    const service = new ProviderHealthService(pool);

    await service.recordObservation(vendor.id, account.id, {
      status: "unhealthy",
      latencyMs: null,
      errorCategory: "network",
      safeErrorCode: "ECONNRESET",
      source: "manual",
      checkedAt: new Date(),
    });
    await service.recordObservation(vendor.id, account.id, {
      status: "degraded",
      latencyMs: 4000,
      errorCategory: "rate_limit",
      safeErrorCode: "429",
      source: "manual",
      checkedAt: new Date(),
    });

    const current = await service.getCurrentHealth(vendor.id, account.id);
    assert.equal(current?.status, "degraded");
    assert.equal(current?.consecutive_failures, 0);
  });
});

test("history is returned most-recent-first and respects the limit query parameter", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);
    const service = new ProviderHealthService(pool);

    for (let i = 0; i < 5; i++) {
      await service.recordObservation(vendor.id, account.id, {
        status: "healthy",
        latencyMs: 100 + i,
        errorCategory: null,
        safeErrorCode: null,
        source: "manual",
        checkedAt: new Date(Date.now() + i * 1000),
      });
    }

    const res = await app.inject({
      method: "GET",
      url: `/v1/vendors/${vendor.id}/accounts/${account.id}/health/events?limit=2`,
    });
    assert.equal(res.statusCode, 200);
    const events = res.json().events;
    assert.equal(events.length, 2);
    assert.equal(events[0].latencyMs, 104);
    assert.equal(events[1].latencyMs, 103);
  });
});

test("recording an observation for a nonexistent vendor account is rejected, not a 500", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor } = await createVendorWithAccount(app);
    const service = new ProviderHealthService(pool);

    await assert.rejects(
      () =>
        service.recordObservation(vendor.id, MISSING_ID, {
          status: "healthy",
          latencyMs: null,
          errorCategory: null,
          safeErrorCode: null,
          source: "manual",
          checkedAt: new Date(),
        }),
      NotFoundError,
    );
  });
});

test("an account belonging to a different vendor is not accessible via the wrong vendor id", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { account } = await createVendorWithAccount(app);
    const otherVendor = (
      await app.inject({
        method: "POST",
        url: "/v1/vendors",
        payload: { ...sampleVendorPayload, slug: "other-vendor" },
      })
    ).json().vendor;

    const service = new ProviderHealthService(pool);
    await assert.rejects(
      () =>
        service.recordObservation(otherVendor.id, account.id, {
          status: "healthy",
          latencyMs: null,
          errorCategory: null,
          safeErrorCode: null,
          source: "manual",
          checkedAt: new Date(),
        }),
      NotFoundError,
    );

    const res = await app.inject({ method: "GET", url: `/v1/vendors/${otherVendor.id}/accounts/${account.id}/health` });
    assert.equal(res.statusCode, 404);
  });
});

test("health can be recorded and read for a disabled account — recording history is not a usage decision", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app, { status: "disabled" });
    const service = new ProviderHealthService(pool);

    await service.recordObservation(vendor.id, account.id, {
      status: "unhealthy",
      latencyMs: null,
      errorCategory: "authentication",
      safeErrorCode: "401",
      source: "manual",
      checkedAt: new Date(),
    });

    const res = await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}/accounts/${account.id}/health` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().health.status, "unhealthy");
  });
});

test("disabling and re-enabling an account never touches its recorded health history", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);
    const service = new ProviderHealthService(pool);

    // Enabled account accrues a healthy history.
    await service.recordObservation(vendor.id, account.id, {
      status: "healthy",
      latencyMs: 75,
      errorCategory: null,
      safeErrorCode: null,
      source: "manual",
      checkedAt: new Date(),
    });
    const beforeDisable = await service.getCurrentHealth(vendor.id, account.id);
    assert.equal(beforeDisable?.status, "healthy");

    const disableRes = await app.inject({ method: "DELETE", url: `/v1/vendors/${vendor.id}/accounts/${account.id}` });
    assert.equal(disableRes.statusCode, 200);
    assert.equal(disableRes.json().account.status, "disabled");

    // Administrative disable must not silently alter or delete health state.
    const whileDisabled = await service.getCurrentHealth(vendor.id, account.id);
    assert.equal(whileDisabled?.status, "healthy");
    assert.equal(whileDisabled?.last_latency_ms, 75);
    const historyWhileDisabled = await service.getHistory(vendor.id, account.id, 50);
    assert.equal(historyWhileDisabled.length, 1);

    const reEnableRes = await app.inject({
      method: "PATCH",
      url: `/v1/vendors/${vendor.id}/accounts/${account.id}`,
      payload: { status: "enabled" },
    });
    assert.equal(reEnableRes.statusCode, 200);

    // Re-enabling preserves prior health and still allows new observations.
    const afterReEnable = await service.getCurrentHealth(vendor.id, account.id);
    assert.equal(afterReEnable?.status, "healthy");
    await service.recordObservation(vendor.id, account.id, {
      status: "unhealthy",
      latencyMs: null,
      errorCategory: "timeout",
      safeErrorCode: "ETIMEDOUT",
      source: "manual",
      checkedAt: new Date(),
    });
    const finalHistory = await service.getHistory(vendor.id, account.id, 50);
    assert.equal(finalHistory.length, 2);
  });
});

test("recording a health observation never creates an audit_events row", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);
    const service = new ProviderHealthService(pool);

    const before = await pool.query("SELECT count(*)::int AS n FROM audit_events");
    await service.recordObservation(vendor.id, account.id, {
      status: "unhealthy",
      latencyMs: 50,
      errorCategory: "provider_error",
      safeErrorCode: "500",
      source: "adapter",
      checkedAt: new Date(),
    });
    const after = await pool.query("SELECT count(*)::int AS n FROM audit_events");
    assert.equal(after.rows[0].n, before.rows[0].n);
  });
});

test("deleting a vendor account cascades and leaves no orphaned health rows", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { vendor, account } = await createVendorWithAccount(app);
    const service = new ProviderHealthService(pool);

    await service.recordObservation(vendor.id, account.id, {
      status: "healthy",
      latencyMs: 10,
      errorCategory: null,
      safeErrorCode: null,
      source: "manual",
      checkedAt: new Date(),
    });
    await service.recordObservation(vendor.id, account.id, {
      status: "unhealthy",
      latencyMs: null,
      errorCategory: "timeout",
      safeErrorCode: "ETIMEDOUT",
      source: "manual",
      checkedAt: new Date(),
    });

    const beforeSnapshot = await pool.query("SELECT count(*)::int AS n FROM vendor_account_health WHERE vendor_account_id = $1", [account.id]);
    const beforeEvents = await pool.query("SELECT count(*)::int AS n FROM vendor_account_health_events WHERE vendor_account_id = $1", [account.id]);
    assert.equal(beforeSnapshot.rows[0].n, 1);
    assert.equal(beforeEvents.rows[0].n, 2);

    // Hard-delete the account directly at the DB layer (the API never does
    // this — accounts are only ever soft-disabled — but the FK constraint
    // must still hold if a row is ever removed by direct DB access).
    await pool.query("DELETE FROM vendor_accounts WHERE id = $1", [account.id]);

    const afterSnapshot = await pool.query("SELECT count(*)::int AS n FROM vendor_account_health WHERE vendor_account_id = $1", [account.id]);
    const afterEvents = await pool.query("SELECT count(*)::int AS n FROM vendor_account_health_events WHERE vendor_account_id = $1", [account.id]);
    assert.equal(afterSnapshot.rows[0].n, 0);
    assert.equal(afterEvents.rows[0].n, 0);
  });
});

test("the database rejects a negative consecutive_failures value independent of application code", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { account } = await createVendorWithAccount(app);
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO vendor_account_health (vendor_account_id, status, consecutive_failures, last_checked_at)
         VALUES ($1, 'healthy', -1, now())`,
        [account.id],
      ),
    );
  });
});

test("the database rejects negative latency on both the snapshot and the event table independent of application code", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { account } = await createVendorWithAccount(app);
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO vendor_account_health (vendor_account_id, status, last_checked_at, last_latency_ms)
         VALUES ($1, 'healthy', now(), -5)`,
        [account.id],
      ),
    );
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO vendor_account_health_events (vendor_account_id, status, source, checked_at, latency_ms)
         VALUES ($1, 'healthy', 'manual', now(), -5)`,
        [account.id],
      ),
    );
  });
});

test("the database rejects a second current-health row for the same account (UNIQUE constraint)", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const { account } = await createVendorWithAccount(app);
    await pool.query(
      `INSERT INTO vendor_account_health (vendor_account_id, status, last_checked_at) VALUES ($1, 'healthy', now())`,
      [account.id],
    );
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO vendor_account_health (vendor_account_id, status, last_checked_at) VALUES ($1, 'unhealthy', now())`,
        [account.id],
      ),
    );
  });
});

test("the database rejects a health row referencing a nonexistent vendor account (FK constraint)", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO vendor_account_health (vendor_account_id, status, last_checked_at) VALUES ($1, 'healthy', now())`,
        [MISSING_ID],
      ),
    );
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO vendor_account_health_events (vendor_account_id, status, source, checked_at) VALUES ($1, 'healthy', 'manual', now())`,
        [MISSING_ID],
      ),
    );
  });
});

test("health rows contain no secret-shaped columns and no raw provider response data", async () => {
  await withMigratedApp(async (app, pool) => {
    const healthColumns = (
      await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'inhouse' AND table_name = 'vendor_account_health'`,
      )
    ).rows.map((r) => r.column_name);
    const eventColumns = (
      await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'inhouse' AND table_name = 'vendor_account_health_events'`,
      )
    ).rows.map((r) => r.column_name);
    for (const columns of [healthColumns, eventColumns]) {
      assert.ok(!columns.some((c) => /secret|credential|token|password|api_key|response_body|raw_/i.test(c)));
    }
  });
});
