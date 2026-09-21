import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { AdapterRegistry } from "../../src/services/adapters/adapterRegistry.js";
import { OpenAiCompatibleAdapter } from "../../src/services/adapters/openAiCompatibleAdapter.js";
import type { ProviderAdapter } from "../../src/services/providerAdapter.js";
import {
  ADMIN,
  REAL_SECRET,
  createAccountAndCredential,
  createApiKey,
  createVendor,
  createWorkload,
  startMockProviderServer,
  type MockBehavior,
} from "./executionSupport.js";
import { truncateAll, withMigratedApp } from "./helpers.js";

const verifyUrl = (vendorId: string, accountId: string) => `/v1/vendors/${vendorId}/accounts/${accountId}/verify`;

async function count(pool: Pool, table: string): Promise<number> {
  return Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
}

async function setUp(app: FastifyInstance, pool: Pool, baseEndpoint: string, vendorOverrides: Record<string, unknown> = {}) {
  await truncateAll(pool, "inhouse");
  const vendor = await createVendor(app, baseEndpoint, vendorOverrides);
  const { account, credential } = await createAccountAndCredential(app, vendor.id);
  return { vendor, account, credential };
}

async function withProvider(
  behavior: MockBehavior,
  fn: (ctx: { app: FastifyInstance; pool: Pool; baseEndpoint: string; requestCount: () => number; auth: string[] }) => Promise<void>,
  appOptions: Parameters<typeof withMigratedApp>[1] = {},
) {
  const server = await startMockProviderServer(behavior);
  try {
    await withMigratedApp(
      (app, pool) =>
        fn({ app, pool, baseEndpoint: server.baseEndpoint, requestCount: server.requestCount, auth: server.receivedAuthHeaders }),
      appOptions,
    );
  } finally {
    await server.close();
  }
}

test("verify rejects a missing admin token, a bad token, and a client execution key", async () => {
  await withProvider("success", async ({ app, pool, baseEndpoint, requestCount }) => {
    const { vendor, account } = await setUp(app, pool, baseEndpoint);
    const workload = await createWorkload(pool);
    const { rawKey } = await createApiKey(app, [workload.id]);

    const none = await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id) });
    assert.equal(none.statusCode, 401);
    const bad = await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: { authorization: "Bearer nope" } });
    assert.equal(bad.statusCode, 401);
    const client = await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: { authorization: `Bearer ${rawKey}` } });
    assert.equal(client.statusCode, 401);
    assert.equal(requestCount(), 0, "no provider request may happen for an unauthenticated caller");
  });
});

test("verify: unknown vendor, cross-vendor account, disabled vendor/account, no credential, unsupported protocol all fail safely without contacting the provider", async () => {
  await withProvider("success", async ({ app, pool, baseEndpoint, requestCount }) => {
    const a = await setUp(app, pool, baseEndpoint);
    const other = await createVendor(app, baseEndpoint, { slug: "other-vendor" });

    const unknown = await app.inject({ method: "POST", url: verifyUrl("00000000-0000-4000-8000-000000000000", a.account.id), headers: ADMIN });
    assert.equal(unknown.statusCode, 404);
    const malformed = await app.inject({ method: "POST", url: verifyUrl("not-a-uuid", a.account.id), headers: ADMIN });
    assert.equal(malformed.statusCode, 400);

    // Account belongs to vendor A, addressed through vendor B.
    const cross = await app.inject({ method: "POST", url: verifyUrl(other.id, a.account.id), headers: ADMIN });
    assert.equal(cross.statusCode, 404);

    // No enabled credential.
    await app.inject({ method: "PATCH", url: `/v1/vendors/${a.vendor.id}/credentials/${a.credential.id}`, headers: ADMIN, payload: { status: "disabled" } });
    const noCred = await app.inject({ method: "POST", url: verifyUrl(a.vendor.id, a.account.id), headers: ADMIN });
    assert.equal(noCred.statusCode, 409);
    await app.inject({ method: "PATCH", url: `/v1/vendors/${a.vendor.id}/credentials/${a.credential.id}`, headers: ADMIN, payload: { status: "enabled" } });

    // Disabled account.
    await app.inject({ method: "PATCH", url: `/v1/vendors/${a.vendor.id}/accounts/${a.account.id}`, headers: ADMIN, payload: { status: "disabled" } });
    const disabledAccount = await app.inject({ method: "POST", url: verifyUrl(a.vendor.id, a.account.id), headers: ADMIN });
    assert.equal(disabledAccount.statusCode, 409);
    await app.inject({ method: "PATCH", url: `/v1/vendors/${a.vendor.id}/accounts/${a.account.id}`, headers: ADMIN, payload: { status: "enabled" } });

    // Disabled vendor.
    await app.inject({ method: "PATCH", url: `/v1/vendors/${a.vendor.id}`, headers: ADMIN, payload: { status: "disabled" } });
    const disabledVendor = await app.inject({ method: "POST", url: verifyUrl(a.vendor.id, a.account.id), headers: ADMIN });
    assert.equal(disabledVendor.statusCode, 409);
    await app.inject({ method: "PATCH", url: `/v1/vendors/${a.vendor.id}`, headers: ADMIN, payload: { status: "enabled" } });

    // Unsupported technical protocol.
    await pool.query("UPDATE vendors SET protocol = 'unregistered-protocol' WHERE id = $1", [a.vendor.id]);
    const noAdapter = await app.inject({ method: "POST", url: verifyUrl(a.vendor.id, a.account.id), headers: ADMIN });
    assert.equal(noAdapter.statusCode, 409);
    assert.match(noAdapter.json().error.message, /technical protocol/);

    assert.equal(requestCount(), 0);
    assert.equal(await count(pool, "vendor_account_health_events"), 0, "rejected verifications record no health");
  });
});

test("healthy provider -> healthy result; creates health snapshot + event + audit; no ledger rows; secret not in response or audit", async () => {
  await withProvider("success", async ({ app, pool, baseEndpoint, auth }) => {
    const { vendor, account } = await setUp(app, pool, baseEndpoint);
    const res = await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: { ...ADMIN, "x-request-id": "verify-req-1" } });
    assert.equal(res.statusCode, 200);
    const v = res.json().verification;
    assert.equal(v.status, "healthy");
    assert.equal(v.errorCategory, null);
    assert.equal(v.protocol, "openai-compatible");
    assert.equal(typeof v.latencyMs, "number");
    assert.ok(v.checkedAt);
    assert.equal(auth[0], `Bearer ${REAL_SECRET}`, "the adapter received the decrypted secret");

    assert.ok(!res.body.includes(REAL_SECRET));
    assert.ok(!/ciphertext|authTag|secret_/i.test(res.body));

    const health = (await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}/accounts/${account.id}/health`, headers: ADMIN })).json().health;
    assert.equal(health.status, "healthy");
    assert.equal(await count(pool, "vendor_account_health_events"), 1);

    const audit = (await pool.query("SELECT * FROM audit_events WHERE action = 'vendor_account.verified'")).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].request_id, "verify-req-1");
    assert.equal(audit[0].metadata.status, "healthy");
    assert.equal(audit[0].metadata.vendorId, vendor.id);
    assert.ok(!JSON.stringify(audit[0]).includes(REAL_SECRET));

    assert.equal(await count(pool, "usage_ledger"), 0);
  });
});

test("provider failures become safe normalized results; the provider error body never leaks; consecutive failures follow health rules", async () => {
  for (const [behavior, category, code] of [
    ["unauthorized", "authentication", "401"],
    ["serverError", "provider_error", "500"],
    ["rateLimit", "rate_limit", "429"],
  ] as const) {
    await withProvider(behavior, async ({ app, pool, baseEndpoint }) => {
      const { vendor, account } = await setUp(app, pool, baseEndpoint);
      const res = await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: ADMIN });
      assert.equal(res.statusCode, 200);
      const v = res.json().verification;
      assert.notEqual(v.status, "healthy");
      assert.equal(v.errorCategory, category);
      assert.equal(v.safeErrorCode, code);
      assert.ok(!res.body.includes("invalid api key"), "provider error body must not be returned");
      assert.ok(!res.body.includes("internal provider error"));
      assert.ok(!res.body.includes(REAL_SECRET));

      await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: ADMIN });
      const row = (await pool.query("SELECT * FROM vendor_account_health WHERE vendor_account_id = $1", [account.id])).rows[0];
      assert.equal(row.consecutive_failures, v.status === "unhealthy" ? 2 : 0);

      const audit = JSON.stringify((await pool.query("SELECT * FROM audit_events WHERE action = 'vendor_account.verified'")).rows);
      assert.ok(!audit.includes("invalid api key") && !audit.includes(REAL_SECRET));
    });
  }
});

test("a hung provider yields a bounded, safe timeout result", async () => {
  await withProvider("hang", async ({ app, pool, baseEndpoint }) => {
    const { vendor, account } = await setUp(app, pool, baseEndpoint, { timeoutMs: 300 });
    const started = Date.now();
    const res = await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: ADMIN });
    assert.ok(Date.now() - started < 3000);
    const v = res.json().verification;
    assert.equal(v.status, "unhealthy");
    assert.equal(v.errorCategory, "timeout");
  });
});

test("a credential that cannot be decrypted causes no provider request and a safe configuration result", async () => {
  await withProvider("success", async ({ app, pool, baseEndpoint, requestCount }) => {
    const { vendor, account, credential } = await setUp(app, pool, baseEndpoint);
    await pool.query("UPDATE vendor_credentials SET secret_ciphertext = $2 WHERE id = $1", [credential.id, Buffer.from("corrupted-bytes")]);
    const res = await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: ADMIN });
    assert.equal(res.statusCode, 200);
    const v = res.json().verification;
    assert.equal(v.status, "unhealthy");
    assert.equal(v.errorCategory, "configuration");
    assert.equal(v.safeErrorCode, "CREDENTIAL_UNAVAILABLE");
    assert.equal(requestCount(), 0);
    assert.equal(await count(pool, "vendor_account_health_events"), 1);
  });
});

test("verification performs exactly one checkHealth and never execute/executeStream, routing, or ledger writes", async () => {
  const calls = { checkHealth: 0, execute: 0, executeStream: 0 };
  const spy: ProviderAdapter = {
    protocol: "openai-compatible",
    async checkHealth() {
      calls.checkHealth++;
      return { status: "degraded", latencyMs: 12, errorCategory: "rate_limit", safeErrorCode: "429" };
    },
    async execute() {
      calls.execute++;
      throw new Error("execute must not be called");
    },
    async executeStream() {
      calls.executeStream++;
      throw new Error("executeStream must not be called");
    },
  };
  const registry = new AdapterRegistry();
  registry.register(spy);
  await withProvider(
    "success",
    async ({ app, pool, baseEndpoint }) => {
      const { vendor, account } = await setUp(app, pool, baseEndpoint);
      const res = await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: ADMIN });
      assert.equal(res.json().verification.status, "degraded");
      assert.deepEqual(calls, { checkHealth: 1, execute: 0, executeStream: 0 });
      assert.equal(await count(pool, "usage_ledger"), 0);
      // Degraded observations do not count as consecutive failures (existing health rule).
      const row = (await pool.query("SELECT * FROM vendor_account_health")).rows[0];
      assert.equal(row.status, "degraded");
      assert.equal(row.consecutive_failures, 0);
    },
    { adapterRegistry: registry },
  );

  const source = await readFile(new URL("../../src/services/providerVerificationService.ts", import.meta.url), "utf8");
  assert.ok(!/routingService|executionService|usageLedger|apiKey/i.test(source.replace(/\/\*[\s\S]*?\*\//g, "")));
});

test("verify works against the real OpenAI-compatible adapter registered by default", async () => {
  await withProvider(
    "success",
    async ({ app, pool, baseEndpoint }) => {
      const { vendor, account } = await setUp(app, pool, baseEndpoint);
      const res = await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: ADMIN });
      assert.equal(res.json().verification.status, "healthy");
    },
    (() => {
      const registry = new AdapterRegistry();
      registry.register(new OpenAiCompatibleAdapter());
      return { adapterRegistry: registry };
    })(),
  );
});

test("verification selects the same credential as readiness and execution: identical created_at resolves on the lowest id", async () => {
  for (const insertLowestFirst of [true, false]) {
    await withProvider("success", async ({ app, pool, baseEndpoint, auth }) => {
      const { vendor, account, credential: first } = await setUp(app, pool, baseEndpoint);
      const secondSecret = "second-managed-secret-000000";
      const second = (
        await app.inject({
          method: "POST",
          url: `/v1/vendors/${vendor.id}/credentials`,
          headers: ADMIN,
          payload: { vendorAccountId: account.id, credentialType: "api_key", secret: secondSecret },
        })
      ).json().credential;

      const byId = [first, second].sort((a, b) => (a.id < b.id ? -1 : 1));
      const [lowest, highest] = byId as [typeof first, typeof first];
      const secretOf = (id: string) => (id === first.id ? REAL_SECRET : secondSecret);

      // Force an exact tie. Touch rows in the requested order so physical row order can favor either one.
      const order = insertLowestFirst ? [lowest, highest] : [highest, lowest];
      for (const c of order) {
        await pool.query("UPDATE vendor_credentials SET created_at = '2026-01-01T00:00:00Z' WHERE id = $1", [c.id]);
      }

      const res = await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: ADMIN });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(auth, [`Bearer ${secretOf(lowest.id)}`], "the adapter was called with the lowest-id credential's secret");

      // Only the selected credential is stamped.
      const stamped = (await pool.query("SELECT id FROM vendor_credentials WHERE last_tested_at IS NOT NULL")).rows.map((r) => r.id);
      assert.deepEqual(stamped, [lowest.id]);

      // Readiness reports that same credential (its timestamps are the ones just stamped).
      const readiness = (await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}/accounts/${account.id}/readiness`, headers: ADMIN })).json().readiness;
      const testedAt = (await pool.query("SELECT last_tested_at FROM vendor_credentials WHERE id = $1", [lowest.id])).rows[0].last_tested_at as Date;
      assert.equal(new Date(readiness.credential.lastTestedAt).getTime(), testedAt.getTime());
    });
  }
});
