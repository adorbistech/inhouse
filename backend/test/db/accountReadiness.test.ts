import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { CredentialVaultService } from "../../src/lib/credentialVault.js";
import { AdapterRegistry } from "../../src/services/adapters/adapterRegistry.js";
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
import { TEST_VAULT_KEY, truncateAll, withMigratedApp } from "./helpers.js";

const readinessUrl = (v: string, a: string) => `/v1/vendors/${v}/accounts/${a}/readiness`;
const verifyUrl = (v: string, a: string) => `/v1/vendors/${v}/accounts/${a}/verify`;
const ZERO = "00000000-0000-4000-8000-000000000000";

async function count(pool: Pool, table: string): Promise<number> {
  return Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
}

async function getReadiness(app: FastifyInstance, v: string, a: string) {
  const res = await app.inject({ method: "GET", url: readinessUrl(v, a), headers: ADMIN });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().readiness;
}

async function patch(app: FastifyInstance, url: string, payload: Record<string, unknown>) {
  const res = await app.inject({ method: "PATCH", url, headers: ADMIN, payload });
  assert.equal(res.statusCode, 200, res.body);
}

async function withProvider(
  behavior: MockBehavior,
  fn: (ctx: { app: FastifyInstance; pool: Pool; baseEndpoint: string; requestCount: () => number }) => Promise<void>,
  appOptions: Parameters<typeof withMigratedApp>[1] = {},
) {
  const server = await startMockProviderServer(behavior);
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      await fn({ app, pool, baseEndpoint: server.baseEndpoint, requestCount: server.requestCount });
    }, appOptions);
  } finally {
    await server.close();
  }
}

async function setUp(app: FastifyInstance, baseEndpoint: string) {
  const vendor = await createVendor(app, baseEndpoint);
  const { account, credential } = await createAccountAndCredential(app, vendor.id);
  return { vendor, account, credential };
}

async function seedHealth(pool: Pool, accountId: string, status: string) {
  await pool.query(
    `INSERT INTO vendor_account_health (vendor_account_id, status, consecutive_failures, last_checked_at)
     VALUES ($1, $2, $3, now())`,
    [accountId, status, status === "unhealthy" ? 1 : 0],
  );
}

test("readiness precedence: healthy -> ready; disabled vendor/account; unsupported; missing credential; unverified; unhealthy", async () => {
  await withProvider("success", async ({ app, pool, baseEndpoint }) => {
    const { vendor, account, credential } = await setUp(app, baseEndpoint);

    // 7/8: no health observation -> unverified
    let r = await getReadiness(app, vendor.id, account.id);
    assert.equal(r.readiness, "unverified");
    assert.equal(r.reason, "never_verified");
    assert.equal(r.health.status, "unknown");
    assert.equal(r.credential.usable, true);
    assert.equal(r.adapterSupported, true);

    // explicit 'unknown' snapshot is also unverified
    await seedHealth(pool, account.id, "unknown");
    r = await getReadiness(app, vendor.id, account.id);
    assert.equal(r.readiness, "unverified");

    // 9: unhealthy
    await pool.query("UPDATE vendor_account_health SET status = 'unhealthy', consecutive_failures = 3, last_error_category = 'timeout' WHERE vendor_account_id = $1", [account.id]);
    r = await getReadiness(app, vendor.id, account.id);
    assert.equal(r.readiness, "unhealthy");
    assert.equal(r.reason, "last_check_unhealthy");
    assert.equal(r.health.consecutiveFailures, 3);
    assert.equal(r.health.lastErrorCategory, "timeout");

    // 1/10: healthy -> ready
    await pool.query("UPDATE vendor_account_health SET status = 'healthy', consecutive_failures = 0 WHERE vendor_account_id = $1", [account.id]);
    r = await getReadiness(app, vendor.id, account.id);
    assert.equal(r.readiness, "ready");
    assert.equal(r.reason, "last_check_healthy");

    // degraded is still usable
    await pool.query("UPDATE vendor_account_health SET status = 'degraded' WHERE vendor_account_id = $1", [account.id]);
    assert.equal((await getReadiness(app, vendor.id, account.id)).reason, "last_check_degraded");
    await pool.query("UPDATE vendor_account_health SET status = 'healthy' WHERE vendor_account_id = $1", [account.id]);

    // 5: no enabled credential
    await patch(app, `/v1/vendors/${vendor.id}/credentials/${credential.id}`, { status: "disabled" });
    r = await getReadiness(app, vendor.id, account.id);
    assert.equal(r.readiness, "missing_credential");
    assert.equal(r.reason, "no_enabled_credential");
    assert.equal(r.credential.present, true);
    assert.equal(r.credential.enabled, false);
    await patch(app, `/v1/vendors/${vendor.id}/credentials/${credential.id}`, { status: "enabled" });

    // 4: unsupported adapter (takes precedence over credential/health state)
    await pool.query("UPDATE vendors SET protocol = 'unregistered-protocol' WHERE id = $1", [vendor.id]);
    r = await getReadiness(app, vendor.id, account.id);
    assert.equal(r.readiness, "unsupported");
    assert.equal(r.adapterSupported, false);
    await pool.query("UPDATE vendors SET protocol = 'openai-compatible' WHERE id = $1", [vendor.id]);

    // 3: disabled account (beats everything below it)
    await patch(app, `/v1/vendors/${vendor.id}/accounts/${account.id}`, { status: "disabled" });
    r = await getReadiness(app, vendor.id, account.id);
    assert.equal(r.readiness, "disabled");
    assert.equal(r.reason, "account_not_enabled");
    assert.equal(r.accountStatus, "disabled");
    await patch(app, `/v1/vendors/${vendor.id}/accounts/${account.id}`, { status: "enabled" });

    // 2: disabled vendor
    await patch(app, `/v1/vendors/${vendor.id}`, { status: "disabled" });
    r = await getReadiness(app, vendor.id, account.id);
    assert.equal(r.readiness, "disabled");
    assert.equal(r.reason, "vendor_not_enabled");
    assert.equal(r.vendorStatus, "disabled");
  });
});

test("an account with no credentials at all, and one with only a secretRef credential, are missing_credential", async () => {
  await withProvider("success", async ({ app, pool, baseEndpoint }) => {
    const vendor = await createVendor(app, baseEndpoint);
    const account = (await app.inject({ method: "POST", url: `/v1/vendors/${vendor.id}/accounts`, headers: ADMIN, payload: { slug: "bare", displayName: "Bare" } })).json().account;
    await seedHealth(pool, account.id, "healthy");

    let r = await getReadiness(app, vendor.id, account.id);
    assert.equal(r.readiness, "missing_credential");
    assert.equal(r.credential.present, false);

    // 6: secretRef-only -> enabled but not usable (Inhouse cannot decrypt it)
    const res = await app.inject({
      method: "POST", url: `/v1/vendors/${vendor.id}/credentials`, headers: ADMIN,
      payload: { vendorAccountId: account.id, credentialType: "api_key", secretRef: "vault://external/thing" },
    });
    assert.equal(res.statusCode, 201);
    r = await getReadiness(app, vendor.id, account.id);
    assert.equal(r.readiness, "missing_credential");
    assert.equal(r.reason, "credential_not_usable");
    assert.equal(r.credential.enabled, true);
    assert.equal(r.credential.usable, false);
    const body = JSON.stringify(r);
    assert.ok(!body.includes("vault://external/thing"), "secretRef must not be exposed");
  });
});

test("multiple enabled credentials: the oldest enabled one is the deterministic selected candidate", async () => {
  await withProvider("success", async ({ app, pool, baseEndpoint }) => {
    const { vendor, account, credential: first } = await setUp(app, baseEndpoint);
    await seedHealth(pool, account.id, "healthy");
    const second = (await app.inject({
      method: "POST", url: `/v1/vendors/${vendor.id}/credentials`, headers: ADMIN,
      payload: { vendorAccountId: account.id, credentialType: "api_key", secret: "another-secret-value-123456" },
    })).json().credential;
    await pool.query("UPDATE vendor_credentials SET last_tested_at = '2030-01-01T00:00:00Z' WHERE id = $1", [second.id]);
    await pool.query("UPDATE vendor_credentials SET last_tested_at = '2029-01-01T00:00:00Z' WHERE id = $1", [first.id]);

    let r = await getReadiness(app, vendor.id, account.id);
    assert.equal(new Date(r.credential.lastTestedAt).getUTCFullYear(), 2029, "oldest enabled credential is selected");

    // Disabling the older one moves selection to the next enabled credential.
    await patch(app, `/v1/vendors/${vendor.id}/credentials/${first.id}`, { status: "disabled" });
    r = await getReadiness(app, vendor.id, account.id);
    assert.equal(new Date(r.credential.lastTestedAt).getUTCFullYear(), 2030);

    // If the oldest enabled credential is secretRef-only it is still the selected one (matches execution) -> not usable.
    await patch(app, `/v1/vendors/${vendor.id}/credentials/${first.id}`, { status: "enabled", secretRef: "ref://x" });
    r = await getReadiness(app, vendor.id, account.id);
    assert.equal(r.reason, "credential_not_usable");
  });
});

test("readiness 404s: unknown vendor, unknown account, cross-vendor account; 400 for malformed ids", async () => {
  await withProvider("success", async ({ app, baseEndpoint }) => {
    const a = await setUp(app, baseEndpoint);
    const other = await createVendor(app, baseEndpoint, { slug: "other-vendor" });
    const get = (url: string) => app.inject({ method: "GET", url, headers: ADMIN });
    assert.equal((await get(readinessUrl(ZERO, a.account.id))).statusCode, 404);
    assert.equal((await get(readinessUrl(a.vendor.id, ZERO))).statusCode, 404);
    assert.equal((await get(readinessUrl(other.id, a.account.id))).statusCode, 404);
    assert.equal((await get(readinessUrl("not-a-uuid", a.account.id))).statusCode, 400);
  });
});

test("readiness requires the admin token: anonymous, wrong token and ihk_ client keys are rejected", async () => {
  await withProvider("success", async ({ app, pool, baseEndpoint, requestCount }) => {
    const { vendor, account } = await setUp(app, baseEndpoint);
    const workload = await createWorkload(pool);
    const { rawKey } = await createApiKey(app, [workload.id]);
    const url = readinessUrl(vendor.id, account.id);
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url, headers: { authorization: "Bearer nope" } })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${rawKey}` } })).statusCode, 401);
    assert.equal(requestCount(), 0);
  });
});

test("readiness is a pure read: no provider contact, no decryption, no ledger/health/audit writes, no secret material", async () => {
  const calls = { checkHealth: 0, execute: 0, executeStream: 0 };
  const spy: ProviderAdapter = {
    protocol: "openai-compatible",
    async checkHealth() { calls.checkHealth++; return { status: "healthy", latencyMs: 1, errorCategory: null, safeErrorCode: null }; },
    async execute() { calls.execute++; throw new Error("no"); },
    async executeStream() { calls.executeStream++; throw new Error("no"); },
  };
  const registry = new AdapterRegistry();
  registry.register(spy);
  let decrypts = 0;
  const vault = new CredentialVaultService(TEST_VAULT_KEY);
  const realDecrypt = vault.decrypt.bind(vault);
  vault.decrypt = (record) => { decrypts++; return realDecrypt(record); };

  await withProvider("success", async ({ app, pool, baseEndpoint, requestCount }) => {
    const { vendor, account, credential } = await setUp(app, baseEndpoint);
    // Corrupt ciphertext: any decrypt attempt would throw, yet readiness must still answer.
    await pool.query("UPDATE vendor_credentials SET secret_ciphertext = $2 WHERE id = $1", [credential.id, Buffer.from("corrupted-bytes")]);
    const before = {
      events: await count(pool, "vendor_account_health_events"),
      health: await count(pool, "vendor_account_health"),
      ledger: await count(pool, "usage_ledger"),
      audit: await count(pool, "audit_events"),
    };
    const decryptsBefore = decrypts;

    const res = await app.inject({ method: "GET", url: readinessUrl(vendor.id, account.id), headers: ADMIN });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().readiness.credential.usable, true);

    assert.equal(decrypts, decryptsBefore, "readiness must not decrypt");
    assert.deepEqual(calls, { checkHealth: 0, execute: 0, executeStream: 0 });
    assert.equal(requestCount(), 0, "no provider contact");
    assert.deepEqual(
      { events: await count(pool, "vendor_account_health_events"), health: await count(pool, "vendor_account_health"), ledger: await count(pool, "usage_ledger"), audit: await count(pool, "audit_events") },
      before,
    );
    assert.ok(!res.body.includes(REAL_SECRET));
    assert.ok(!/ciphertext|authTag|auth_tag|fingerprint|secretRef|secret_|masked/i.test(res.body));
  }, { adapterRegistry: registry, credentialVault: vault });
});

test("verification stamps last_tested_at; success also stamps last_successful_at; failure does not; exactly one provider call, no retry", async () => {
  // Success
  await withProvider("success", async ({ app, pool, baseEndpoint, requestCount }) => {
    const { vendor, account, credential } = await setUp(app, baseEndpoint);
    const before = (await pool.query("SELECT last_tested_at, last_successful_at FROM vendor_credentials WHERE id = $1", [credential.id])).rows[0];
    assert.equal(before.last_tested_at, null);
    assert.equal(before.last_successful_at, null);

    const res = await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: ADMIN });
    assert.equal(res.json().verification.status, "healthy");
    assert.equal(requestCount(), 1);
    const row = (await pool.query("SELECT last_tested_at, last_successful_at FROM vendor_credentials WHERE id = $1", [credential.id])).rows[0];
    assert.ok(row.last_tested_at instanceof Date);
    assert.ok(row.last_successful_at instanceof Date);

    const r = await getReadiness(app, vendor.id, account.id);
    assert.ok(r.credential.lastTestedAt && r.credential.lastSuccessfulAt);
    assert.equal(r.readiness, "ready");

    // API credential response now carries real values too.
    const creds = (await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}/credentials`, headers: ADMIN })).json().credentials;
    assert.ok(creds[0].lastTestedAt && creds[0].lastSuccessfulAt);
  });

  // Failure (provider 5xx) after an earlier success: tested advances, successful does not.
  await withProvider("serverError", async ({ app, pool, baseEndpoint, requestCount }) => {
    const { vendor, account, credential } = await setUp(app, baseEndpoint);
    const earlier = new Date("2020-01-01T00:00:00Z");
    await pool.query("UPDATE vendor_credentials SET last_successful_at = $2 WHERE id = $1", [credential.id, earlier]);
    const res = await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: ADMIN });
    assert.notEqual(res.json().verification.status, "healthy");
    assert.equal(requestCount(), 1, "exactly one provider call: no retry or fallback");
    const row = (await pool.query("SELECT last_tested_at, last_successful_at FROM vendor_credentials WHERE id = $1", [credential.id])).rows[0];
    assert.ok(row.last_tested_at instanceof Date);
    assert.equal(row.last_successful_at.getTime(), earlier.getTime(), "failed verification must not touch last_successful_at");
    assert.equal((await getReadiness(app, vendor.id, account.id)).readiness, "unhealthy");
  });

  // Credential that cannot be decrypted: attempted -> tested, never successful.
  await withProvider("success", async ({ app, pool, baseEndpoint, requestCount }) => {
    const { vendor, account, credential } = await setUp(app, baseEndpoint);
    await pool.query("UPDATE vendor_credentials SET secret_ciphertext = $2 WHERE id = $1", [credential.id, Buffer.from("corrupted-bytes")]);
    await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: ADMIN });
    const row = (await pool.query("SELECT last_tested_at, last_successful_at FROM vendor_credentials WHERE id = $1", [credential.id])).rows[0];
    assert.ok(row.last_tested_at instanceof Date);
    assert.equal(row.last_successful_at, null);
    assert.equal(requestCount(), 0);
  });
});

test("only the selected credential is stamped; rejected verifications stamp nothing", async () => {
  await withProvider("success", async ({ app, pool, baseEndpoint }) => {
    const { vendor, account, credential: first } = await setUp(app, baseEndpoint);
    const second = (await app.inject({
      method: "POST", url: `/v1/vendors/${vendor.id}/credentials`, headers: ADMIN,
      payload: { vendorAccountId: account.id, credentialType: "api_key", secret: "another-secret-value-123456" },
    })).json().credential;

    await patch(app, `/v1/vendors/${vendor.id}/accounts/${account.id}`, { status: "disabled" });
    assert.equal((await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: ADMIN })).statusCode, 409);
    assert.equal(await count(pool, "vendor_credentials WHERE last_tested_at IS NOT NULL"), 0);
    await patch(app, `/v1/vendors/${vendor.id}/accounts/${account.id}`, { status: "enabled" });

    await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: ADMIN });
    const rows = (await pool.query("SELECT id, last_tested_at FROM vendor_credentials")).rows;
    assert.ok(rows.find((r) => r.id === first.id).last_tested_at, "oldest enabled credential is the one tested");
    assert.equal(rows.find((r) => r.id === second.id).last_tested_at, null);
  });
});

test("a degraded verification stamps last_tested_at but not last_successful_at, with exactly one checkHealth and no retry", async () => {
  const calls = { checkHealth: 0, execute: 0, executeStream: 0 };
  const spy: ProviderAdapter = {
    protocol: "openai-compatible",
    async checkHealth() {
      calls.checkHealth++;
      return { status: "degraded", latencyMs: 7, errorCategory: "rate_limit", safeErrorCode: "429" };
    },
    async execute() { calls.execute++; throw new Error("execute must not be called"); },
    async executeStream() { calls.executeStream++; throw new Error("executeStream must not be called"); },
  };
  const registry = new AdapterRegistry();
  registry.register(spy);

  await withProvider("success", async ({ app, pool, baseEndpoint, requestCount }) => {
    const { vendor, account, credential } = await setUp(app, baseEndpoint);
    const res = await app.inject({ method: "POST", url: verifyUrl(vendor.id, account.id), headers: ADMIN });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().verification.status, "degraded");

    assert.deepEqual(calls, { checkHealth: 1, execute: 0, executeStream: 0 });
    assert.equal(requestCount(), 0, "the spy adapter replaces the real provider; nothing else is contacted");
    const row = (await pool.query("SELECT last_tested_at, last_successful_at FROM vendor_credentials WHERE id = $1", [credential.id])).rows[0];
    assert.ok(row.last_tested_at instanceof Date, "last_tested_at must be stamped");
    assert.equal(row.last_successful_at, null, "a degraded result must not stamp last_successful_at");

    const r = await getReadiness(app, vendor.id, account.id);
    assert.equal(r.readiness, "ready");
    assert.equal(r.reason, "last_check_degraded");
    assert.ok(r.credential.lastTestedAt);
    assert.equal(r.credential.lastSuccessfulAt, null);
  }, { adapterRegistry: registry });
});
