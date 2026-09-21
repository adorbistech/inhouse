import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { CredentialVaultService } from "../../src/lib/credentialVault.js";
import { UsageLedgerRepository } from "../../src/repositories/usageLedgerRepository.js";
import {
  ADMIN,
  REAL_SECRET,
  createAccountAndCredential,
  createApiKey,
  createModel,
  createTier,
  createVendor,
  createWorkload,
  attachModelToWorkload,
  attachVendorToWorkload,
  startMockProviderServer,
} from "./executionSupport.js";
import { TEST_VAULT_KEY, truncateAll, withMigratedApp } from "./helpers.js";

/** A real vault whose `decrypt` calls are counted — the observable proof of "no decrypt happened". */
class CountingVault extends CredentialVaultService {
  decrypts = 0;
  override decrypt(...args: Parameters<CredentialVaultService["decrypt"]>): string {
    this.decrypts++;
    return super.decrypt(...args);
  }
}

interface Ctx {
  app: FastifyInstance;
  pool: Pool;
  vault: CountingVault;
  server: Awaited<ReturnType<typeof startMockProviderServer>>;
  workloadId: string;
  alias: string;
  rawKey: string;
  vendorId: string;
}

async function scenario(fn: (c: Ctx) => Promise<void>, vendorOverrides: Record<string, unknown> = {}): Promise<void> {
  const server = await startMockProviderServer("success");
  const vault = new CountingVault(TEST_VAULT_KEY);
  try {
    await withMigratedApp(
      async (app, pool) => {
        await truncateAll(pool, "inhouse");
        const workload = await createWorkload(pool);
        const vendor = await createVendor(app, server.baseEndpoint, vendorOverrides);
        const model = await createModel(app, vendor.id);
        await attachVendorToWorkload(app, vendor.id, workload.id);
        await attachModelToWorkload(app, model.id, workload.id);
        await createTier(app, workload.id, vendor.id, model.id);
        const { rawKey } = await createApiKey(app, [workload.id]);
        await fn({ app, pool, vault, server, workloadId: workload.id, alias: model.inhouseAlias as string, rawKey, vendorId: vendor.id });
      },
      { credentialVault: vault },
    );
  } finally {
    await server.close();
  }
}

const post = (c: Ctx, url = "/v1/chat/completions", extra: Record<string, unknown> = {}) =>
  c.app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${c.rawKey}` },
    payload: { workloadId: c.workloadId, model: c.alias, messages: [{ role: "user", content: "hi" }], ...extra },
  });

async function addAccount(c: Ctx, slug: string, secret: string | null, opts: { status?: string; secretRef?: string } = {}) {
  const account = (
    await c.app.inject({ method: "POST", url: `/v1/vendors/${c.vendorId}/accounts`, headers: ADMIN, payload: { slug, displayName: slug, status: opts.status ?? "enabled" } })
  ).json().account;
  if (secret !== null || opts.secretRef) {
    const res = await c.app.inject({
      method: "POST",
      url: `/v1/vendors/${c.vendorId}/credentials`,
      headers: ADMIN,
      payload: { vendorAccountId: account.id, credentialType: "api_key", ...(opts.secretRef ? { secretRef: opts.secretRef } : { secret }) },
    });
    assert.equal(res.statusCode, 201, res.body);
    return { account, credential: res.json().credential };
  }
  return { account, credential: null };
}

async function seedHealth(pool: Pool, accountId: string, status: string) {
  await pool.query(
    `INSERT INTO vendor_account_health (vendor_account_id, status, consecutive_failures, last_checked_at) VALUES ($1, $2, $3, now())`,
    [accountId, status, status === "unhealthy" ? 1 : 0],
  );
}

const ledger = (pool: Pool) => new UsageLedgerRepository(pool).listRecent(20);
const bearerOf = (secret: string) => `Bearer ${secret}`;

function assertNothingAttempted(c: Ctx): void {
  assert.equal(c.vault.decrypts, 0, "no credential may be decrypted");
  assert.equal(c.server.requestCount(), 0, "no provider request may be made");
}

test("a disabled account is skipped: no decrypt, no provider request, configuration failure", async () => {
  await scenario(async (c) => {
    await addAccount(c, "off", "secret-off-account-000000", { status: "disabled" });
    const res = await post(c);
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error.code, "CONFIGURATION");
    assertNothingAttempted(c);
  });
});

test("an unsupported adapter protocol is rejected BEFORE decrypt: decrypt count 0, provider requests 0", async () => {
  await scenario(
    async (c) => {
      await createAccountAndCredential(c.app, c.vendorId);
      const res = await post(c);
      assert.equal(res.statusCode, 502);
      assert.equal(res.json().error.code, "CONFIGURATION");
      assertNothingAttempted(c);
      const rows = await ledger(c.pool);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.error_category, "configuration");
      assert.equal(rows[0]?.vendor_account_id, null, "no account was selected before the adapter was rejected");
      assert.equal(rows[0]?.vendor_id, c.vendorId, "the vendor is still attributed");
    },
    { protocol: "no-such-protocol" },
  );
});

test("an account with no credential, and one with only a disabled credential, are skipped without decrypt", async () => {
  await scenario(async (c) => {
    await addAccount(c, "bare", null);
    const { credential } = await addAccount(c, "disabled-cred", "secret-disabled-cred-0000");
    await c.app.inject({ method: "PATCH", url: `/v1/vendors/${c.vendorId}/credentials/${credential.id}`, headers: ADMIN, payload: { status: "disabled" } });
    const res = await post(c);
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error.code, "CONFIGURATION");
    assertNothingAttempted(c);
  });
});

test("an external secretRef-only credential is skipped: no decrypt attempt, no provider request", async () => {
  await scenario(async (c) => {
    await addAccount(c, "external", null, { secretRef: "vault://external/only" });
    const res = await post(c);
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error.code, "CONFIGURATION");
    assertNothingAttempted(c);
    assert.ok(!res.body.includes("vault://external/only"));
  });
});

test("a managed credential on an unverified (no health row) account executes normally", async () => {
  await scenario(async (c) => {
    await createAccountAndCredential(c.app, c.vendorId);
    const res = await post(c);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(c.vault.decrypts, 1);
    assert.equal(c.server.requestCount(), 1);
    assert.deepEqual(c.server.receivedAuthHeaders, [bearerOf(REAL_SECRET)]);
    assert.equal((await ledger(c.pool)).length, 1);
  });
});

test("health ranking is preserved: healthy > unknown > degraded > unhealthy, one account used per request", async () => {
  await scenario(async (c) => {
    const unhealthy = await addAccount(c, "a-unhealthy", "secret-unhealthy-000000000");
    const degraded = await addAccount(c, "b-degraded", "secret-degraded-0000000000");
    const unknown = await addAccount(c, "c-unknown", "secret-unknown-00000000000");
    const healthy = await addAccount(c, "d-healthy", "secret-healthy-000000000000");
    await seedHealth(c.pool, unhealthy.account.id, "unhealthy");
    await seedHealth(c.pool, degraded.account.id, "degraded");
    await seedHealth(c.pool, healthy.account.id, "healthy");
    void unknown;

    assert.equal((await post(c)).statusCode, 200);
    assert.equal(c.server.receivedAuthHeaders.at(-1), bearerOf("secret-healthy-000000000000"));

    await c.pool.query("UPDATE vendor_account_health SET status = 'unhealthy' WHERE vendor_account_id = $1", [healthy.account.id]);
    assert.equal((await post(c)).statusCode, 200);
    assert.equal(c.server.receivedAuthHeaders.at(-1), bearerOf("secret-unknown-00000000000"), "unknown outranks degraded and unhealthy");

    await c.pool.query("UPDATE vendor_account_health SET status = 'degraded' WHERE vendor_account_id = $1", [healthy.account.id]);
    await c.pool.query("DELETE FROM vendor_account_health WHERE vendor_account_id = $1", [unknown.account.id]);
    await seedHealth(c.pool, unknown.account.id, "unhealthy");
    const res = await post(c);
    assert.equal(res.statusCode, 200, "degraded accounts remain executable");
    assert.ok([bearerOf("secret-healthy-000000000000"), bearerOf("secret-degraded-0000000000")].includes(c.server.receivedAuthHeaders.at(-1)!));
  });
});

test("an unhealthy account remains a usable last resort when it is the only usable account", async () => {
  await scenario(async (c) => {
    const bad = await addAccount(c, "only-unhealthy", "secret-last-resort-0000000");
    await seedHealth(c.pool, bad.account.id, "unhealthy");
    await addAccount(c, "no-credential", null);
    const res = await post(c);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(c.server.receivedAuthHeaders.at(-1), bearerOf("secret-last-resort-0000000"));
  });
});

test("structurally unusable accounts are skipped and execution continues to the next account", async () => {
  await scenario(async (c) => {
    const good = await addAccount(c, "good", "secret-good-account-0000000");
    await addAccount(c, "disabled", "secret-disabled-acct-000000", { status: "disabled" });
    await addAccount(c, "external", null, { secretRef: "vault://ext" });
    await addAccount(c, "bare", null);
    await seedHealth(c.pool, good.account.id, "unhealthy"); // ranked last, still the only usable one
    const res = await post(c);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(c.vault.decrypts, 1, "only the usable account is decrypted");
    assert.deepEqual(c.server.receivedAuthHeaders, [bearerOf("secret-good-account-0000000")]);
  });
});

test("credential selection is deterministic: created_at, then id; and the same rule as readiness", async () => {
  await scenario(async (c) => {
    const { account, credential: first } = await addAccount(c, "multi", "secret-first-credential-000");
    const second = (
      await c.app.inject({
        method: "POST",
        url: `/v1/vendors/${c.vendorId}/credentials`,
        headers: ADMIN,
        payload: { vendorAccountId: account.id, credentialType: "api_key", secret: "secret-second-credential-00" },
      })
    ).json().credential;

    // A created_at tie must resolve on id, whichever row was inserted first.
    await c.pool.query("UPDATE vendor_credentials SET created_at = '2026-01-01T00:00:00Z' WHERE vendor_account_id = $1", [account.id]);
    const lowest = [first.id, second.id].sort()[0]!;
    const expectedSecret = lowest === first.id ? "secret-first-credential-000" : "secret-second-credential-00";
    assert.equal((await post(c)).statusCode, 200);
    assert.equal(c.server.receivedAuthHeaders.at(-1), bearerOf(expectedSecret));

    // Older created_at wins over id order.
    await c.pool.query("UPDATE vendor_credentials SET created_at = '2025-01-01T00:00:00Z' WHERE id = $1", [second.id]);
    assert.equal((await post(c)).statusCode, 200);
    assert.equal(c.server.receivedAuthHeaders.at(-1), bearerOf("secret-second-credential-00"));

    // Readiness reports the same selected credential (timestamps identify it).
    await c.pool.query("UPDATE vendor_credentials SET last_tested_at = '2031-01-01T00:00:00Z' WHERE id = $1", [second.id]);
    const readiness = (await c.app.inject({ method: "GET", url: `/v1/vendors/${c.vendorId}/accounts/${account.id}/readiness`, headers: ADMIN })).json().readiness;
    assert.equal(new Date(readiness.credential.lastTestedAt).getUTCFullYear(), 2031);
  });
});

test("an oldest-enabled external secretRef credential makes the account unusable, matching readiness (no decrypt, no request)", async () => {
  await scenario(async (c) => {
    const { account, credential } = await addAccount(c, "ext-first", null, { secretRef: "vault://ext-first" });
    await c.app.inject({
      method: "POST",
      url: `/v1/vendors/${c.vendorId}/credentials`,
      headers: ADMIN,
      payload: { vendorAccountId: account.id, credentialType: "api_key", secret: "secret-managed-second-0000" },
    });
    await c.pool.query("UPDATE vendor_credentials SET created_at = '2025-01-01T00:00:00Z' WHERE id = $1", [credential.id]);
    const res = await post(c);
    assert.equal(res.statusCode, 502);
    assertNothingAttempted(c);
    const readiness = (await c.app.inject({ method: "GET", url: `/v1/vendors/${c.vendorId}/accounts/${account.id}/readiness`, headers: ADMIN })).json().readiness;
    assert.equal(readiness.reason, "credential_not_usable");
  });
});

test("a credential that fails to decrypt is skipped like before: the next account is used, no secret leaks", async () => {
  await scenario(async (c) => {
    const broken = await addAccount(c, "a-broken", "secret-broken-0000000000000");
    const fine = await addAccount(c, "b-fine", "secret-fine-000000000000000");
    await seedHealth(c.pool, broken.account.id, "healthy");
    await seedHealth(c.pool, fine.account.id, "degraded");
    await c.pool.query("UPDATE vendor_credentials SET secret_ciphertext = '\\x00112233' WHERE id = $1", [broken.credential.id]);
    const res = await post(c);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(c.server.receivedAuthHeaders, [bearerOf("secret-fine-000000000000000")]);
    assert.ok(!res.body.includes("secret-broken"));
  });
});

test("streaming: an ineligible account fails before the stream opens with a normal JSON error, not SSE", async () => {
  await scenario(async (c) => {
    await addAccount(c, "external", null, { secretRef: "vault://ext" });
    const res = await post(c, "/v1/chat/completions", { stream: true });
    assert.equal(res.statusCode, 502);
    assert.ok(!String(res.headers["content-type"]).includes("text/event-stream"));
    assert.equal(res.json().error.code, "CONFIGURATION");
    assert.ok(!res.body.includes("data:"));
    assertNothingAttempted(c);
    assert.equal((await ledger(c.pool)).length, 1, "exactly one ledger row");
  });
});

// ------------------------------------------------------------------ tier fallback (14D)

interface FallbackCtx {
  app: FastifyInstance;
  pool: Pool;
  vault: CountingVault;
  primary: Awaited<ReturnType<typeof startMockProviderServer>>;
  fallback: Awaited<ReturnType<typeof startMockProviderServer>>;
  primaryTierId: string;
  fallbackTierId: string;
  workloadId: string;
  alias: string;
  rawKey: string;
  primaryVendorId: string;
  addRule: (conditionType: string) => Promise<void>;
}

/** Tier 0: a vendor with NO accounts yet (each test adds the structurally unusable ones); tier 1: a fully working vendor. */
async function fallbackScenario(fn: (c: FallbackCtx) => Promise<void>, primaryOverrides: Record<string, unknown> = {}): Promise<void> {
  const primary = await startMockProviderServer("success");
  const fallback = await startMockProviderServer("success");
  const vault = new CountingVault(TEST_VAULT_KEY);
  try {
    await withMigratedApp(
      async (app, pool) => {
        await truncateAll(pool, "inhouse");
        const workload = await createWorkload(pool);

        const pv = await createVendor(app, primary.baseEndpoint, { automaticFallback: true, ...primaryOverrides });
        const pm = await createModel(app, pv.id, { inhouseAlias: `primary-${Math.random().toString(36).slice(2, 8)}` });
        await attachVendorToWorkload(app, pv.id, workload.id);
        await attachModelToWorkload(app, pm.id, workload.id);
        const primaryTier = await createTier(app, workload.id, pv.id, pm.id, { tierNumber: 0 });

        const fv = await createVendor(app, fallback.baseEndpoint);
        const fm = await createModel(app, fv.id, { inhouseAlias: `fallback-${Math.random().toString(36).slice(2, 8)}` });
        await attachVendorToWorkload(app, fv.id, workload.id);
        await attachModelToWorkload(app, fm.id, workload.id);
        await createAccountAndCredential(app, fv.id, "secret-fallback-vendor-00000");
        const fallbackTier = await createTier(app, workload.id, fv.id, fm.id, { tierNumber: 1 });

        const { rawKey } = await createApiKey(app, [workload.id]);
        const addRule = async (conditionType: string) => {
          const res = await app.inject({
            method: "POST",
            url: `/v1/routing/workloads/${workload.id}/fallback-rules`,
            headers: ADMIN,
            payload: { fromTierId: primaryTier.id, toTierId: fallbackTier.id, conditionType, priority: 0, enabled: true },
          });
          assert.equal(res.statusCode, 201, res.body);
        };
        await fn({
          app, pool, vault, primary, fallback,
          primaryTierId: primaryTier.id, fallbackTierId: fallbackTier.id,
          workloadId: workload.id, alias: pm.inhouseAlias as string, rawKey, primaryVendorId: pv.id, addRule,
        });
      },
      { credentialVault: vault },
    );
  } finally {
    await primary.close();
    await fallback.close();
  }
}

const postFallback = (c: FallbackCtx) =>
  c.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${c.rawKey}` },
    payload: { workloadId: c.workloadId, model: c.alias, messages: [{ role: "user", content: "hi" }] },
  });

async function addPrimaryAccount(c: FallbackCtx, slug: string, opts: { secretRef?: string; status?: string } = {}) {
  const account = (
    await c.app.inject({
      method: "POST",
      url: `/v1/vendors/${c.primaryVendorId}/accounts`,
      headers: ADMIN,
      payload: { slug, displayName: slug, status: opts.status ?? "enabled" },
    })
  ).json().account;
  if (opts.secretRef) {
    const res = await c.app.inject({
      method: "POST",
      url: `/v1/vendors/${c.primaryVendorId}/credentials`,
      headers: ADMIN,
      payload: { vendorAccountId: account.id, credentialType: "api_key", secretRef: opts.secretRef },
    });
    assert.equal(res.statusCode, 201, res.body);
  } else if (opts.status === "disabled") {
    const res = await c.app.inject({
      method: "POST",
      url: `/v1/vendors/${c.primaryVendorId}/credentials`,
      headers: ADMIN,
      payload: { vendorAccountId: account.id, credentialType: "api_key", secret: "secret-disabled-primary-000" },
    });
    assert.equal(res.statusCode, 201, res.body);
  }
}

test("fallback: a primary whose accounts are all structurally unusable falls through an on_error rule to the fallback tier", async () => {
  await fallbackScenario(async (c) => {
    await addPrimaryAccount(c, "external-only", { secretRef: "vault://external/primary" });
    await addPrimaryAccount(c, "disabled", { status: "disabled" });
    await addPrimaryAccount(c, "bare");
    await c.addRule("on_error");

    const res = await postFallback(c);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(c.primary.requestCount(), 0, "the unusable primary is never contacted");
    assert.equal(c.fallback.requestCount(), 1);
    assert.deepEqual(c.fallback.receivedAuthHeaders, [bearerOf("secret-fallback-vendor-00000")]);
    assert.equal(c.vault.decrypts, 1, "only the fallback credential is ever decrypted");

    const rows = await ledger(c.pool);
    assert.equal(rows.length, 1, "exactly one ledger row per execution");
    assert.equal(rows[0]?.status, "success");
    assert.equal(rows[0]?.is_fallback, true);
    assert.equal(rows[0]?.attempt_count, 2);
    assert.equal(rows[0]?.primary_tier_id, c.primaryTierId);
    assert.equal(rows[0]?.fallback_tier_id, c.fallbackTierId);
    assert.ok(!res.body.includes("vault://external/primary"));
  });
});

test("fallback: an on_5xx rule does not match a configuration failure, so there is no fallback and the failure is reported", async () => {
  await fallbackScenario(async (c) => {
    await addPrimaryAccount(c, "external-only", { secretRef: "vault://external/primary" });
    await c.addRule("on_5xx");

    const res = await postFallback(c);
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error.code, "CONFIGURATION");
    assert.equal(c.primary.requestCount(), 0);
    assert.equal(c.fallback.requestCount(), 0, "the fallback tier must not be contacted");
    assert.equal(c.vault.decrypts, 0);

    const rows = await ledger(c.pool);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.is_fallback, false);
    assert.equal(rows[0]?.attempt_count, 1);
    assert.equal(rows[0]?.error_category, "configuration");
    assert.equal(rows[0]?.fallback_tier_id, null);
  });
});
