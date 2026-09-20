import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { TEST_VAULT_KEY, truncateAll, withMigratedApp } from "./helpers.js";
import { CredentialVaultService, type EncryptedSecretRecord } from "../../src/lib/credentialVault.js";
import { UsageLedgerRepository } from "../../src/repositories/usageLedgerRepository.js";
import { AdapterRegistry } from "../../src/services/adapters/adapterRegistry.js";
import { OpenAiCompatibleAdapter } from "../../src/services/adapters/openAiCompatibleAdapter.js";
import {
  ADMIN,
  createAccountAndCredential,
  createApiKey,
  createModel,
  createTier,
  createVendor,
  createWorkload,
  startMockProviderServer,
} from "./executionSupport.js";

/** Counts every decrypt — the one place a provider secret can ever be produced. */
class CountingVault extends CredentialVaultService {
  decrypts = 0;
  override decrypt(record: EncryptedSecretRecord): string {
    this.decrypts++;
    return super.decrypt(record);
  }
}

/** Counts every provider-adapter call, then behaves exactly like the real adapter. */
class SpyAdapter extends OpenAiCompatibleAdapter {
  executes = 0;
  streams = 0;
  override execute(...args: Parameters<OpenAiCompatibleAdapter["execute"]>) {
    this.executes++;
    return super.execute(...args);
  }
  override executeStream(...args: Parameters<OpenAiCompatibleAdapter["executeStream"]>) {
    this.streams++;
    return super.executeStream(...args);
  }
}

function spies() {
  const vault = new CountingVault(TEST_VAULT_KEY);
  const adapter = new SpyAdapter();
  const registry = new AdapterRegistry();
  registry.register(adapter);
  return { vault, adapter, registry, providerCalls: () => adapter.executes + adapter.streams };
}

/**
 * The acceptance scenario from the audit: ONE vendor V assigned to BOTH the
 * coding-agent and the application-api workload, one credential C on V,
 * and a routing tier for each workload — so vendor-to-workload routing
 * alone would happily serve either. Only the key-level grant can tell them apart.
 */
async function buildScenario(app: FastifyInstance, pool: Pool, baseEndpoint: string) {
  const coding = await createWorkload(pool, { slug: `coding-agent-${Math.random().toString(36).slice(2, 6)}` });
  const application = await createWorkload(pool, { slug: `application-api-${Math.random().toString(36).slice(2, 6)}` });
  const vendor = await createVendor(app, baseEndpoint, { vendorType: "coding_plan" });
  const model = await createModel(app, vendor.id);
  // PUT replaces the full set, so both workloads go in one call.
  const vendorRes = await app.inject({ headers: ADMIN, method: "PUT", url: `/v1/vendors/${vendor.id}/workloads`, payload: { workloadIds: [coding.id, application.id] } });
  assert.equal(vendorRes.statusCode, 200, vendorRes.body);
  const modelRes = await app.inject({ headers: ADMIN, method: "PUT", url: `/v1/models/${model.id}/workloads`, payload: { workloadIds: [coding.id, application.id] } });
  assert.equal(modelRes.statusCode, 200, modelRes.body);
  await createAccountAndCredential(app, vendor.id);
  await createTier(app, coding.id, vendor.id, model.id);
  await createTier(app, application.id, vendor.id, model.id);

  const keyCoding = await createApiKey(app, [coding.id]);
  const keyApplication = await createApiKey(app, [application.id]);
  return { coding, application, vendor, model, keyCoding, keyApplication };
}

function chat(app: FastifyInstance, rawKey: string, workloadId: string, model: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${rawKey}` },
    payload: { workloadId, model, messages: [{ role: "user", content: "hi" }], ...extra },
  });
}

test("A/B/C: one vendor serves both workloads, yet each key reaches only the workload it was granted", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const sc = await buildScenario(app, pool, server.baseEndpoint);
      const alias = sc.model.inhouseAlias as string;

      assert.equal((await chat(app, sc.keyCoding.rawKey, sc.coding.id, alias)).statusCode, 200);
      assert.equal((await chat(app, sc.keyApplication.rawKey, sc.application.id, alias)).statusCode, 200);
      assert.equal(server.requestCount(), 2, "both permitted requests reach the provider");

      const codeKeyOnApplication = await chat(app, sc.keyCoding.rawKey, sc.application.id, alias);
      assert.equal(codeKeyOnApplication.statusCode, 403);
      assert.equal(codeKeyOnApplication.json().error.code, "WORKLOAD_NOT_PERMITTED");
      const appKeyOnCoding = await chat(app, sc.keyApplication.rawKey, sc.coding.id, alias);
      assert.equal(appKeyOnCoding.statusCode, 403);
      assert.equal(appKeyOnCoding.json().error.code, "WORKLOAD_NOT_PERMITTED");
      assert.equal(server.requestCount(), 2, "a denied request never reaches the provider");
    });
  } finally {
    await server.close();
  }
});

test("acceptance: key K (application-api only) is allowed on application-api and DENIED on coding-agent with no routing, credential, adapter, provider or ledger activity", async () => {
  const server = await startMockProviderServer("success");
  const s = spies();
  try {
    await withMigratedApp(
      async (app, pool) => {
        await truncateAll(pool, "inhouse");
        const sc = await buildScenario(app, pool, server.baseEndpoint);
        const alias = sc.model.inhouseAlias as string;

        const allowed = await chat(app, sc.keyApplication.rawKey, sc.application.id, alias);
        assert.equal(allowed.statusCode, 200, allowed.body);
        const baseline = { decrypts: s.vault.decrypts, calls: s.providerCalls(), provider: server.requestCount(), ledger: (await new UsageLedgerRepository(pool).listRecent(50)).length };
        assert.equal(baseline.decrypts, 1);
        assert.equal(baseline.calls, 1);
        assert.equal(baseline.ledger, 1);

        // Every way of asking for the coding-agent workload with K: unary, streaming, Anthropic shape, x-header workload.
        const attempts = [
          chat(app, sc.keyApplication.rawKey, sc.coding.id, alias),
          chat(app, sc.keyApplication.rawKey, sc.coding.id, alias, { stream: true }),
          app.inject({
            method: "POST",
            url: "/v1/messages",
            headers: { "x-api-key": sc.keyApplication.rawKey },
            payload: { workloadId: sc.coding.id, model: alias, max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
          }),
          app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            headers: { authorization: `Bearer ${sc.keyApplication.rawKey}`, "x-inhouse-workload-id": sc.coding.id },
            payload: { model: alias, messages: [{ role: "user", content: "hi" }] },
          }),
        ];
        for (const res of await Promise.all(attempts)) {
          assert.equal(res.statusCode, 403, res.body);
          assert.ok(!res.body.includes(sc.vendor.id) && !res.body.includes(sc.model.id), "a denial reveals nothing about routing");
        }

        assert.equal(s.vault.decrypts, baseline.decrypts, "no credential was decrypted");
        assert.equal(s.providerCalls(), baseline.calls, "the ProviderAdapter was never reached");
        assert.equal(server.requestCount(), baseline.provider, "the provider was never called");
        assert.equal((await new UsageLedgerRepository(pool).listRecent(50)).length, baseline.ledger, "no usage/charge row was created");
      },
      { credentialVault: s.vault, adapterRegistry: s.registry },
    );
  } finally {
    await server.close();
  }
});

test("D/E: vendor-to-workload assignment alone never overrides the key — a key with no grants is denied everywhere, including a workload that does not exist", async () => {
  const server = await startMockProviderServer("success");
  const s = spies();
  try {
    await withMigratedApp(
      async (app, pool) => {
        await truncateAll(pool, "inhouse");
        const sc = await buildScenario(app, pool, server.baseEndpoint);
        const alias = sc.model.inhouseAlias as string;

        // Grant a throwaway workload, then take every grant away — the key now exists with an empty grant set.
        const spare = await createWorkload(pool);
        const bare = await createApiKey(app, [spare.id]);
        const cleared = await app.inject({ method: "PUT", url: `/v1/api-keys/${bare.apiKey.id}/workloads`, headers: ADMIN, payload: { workloadIds: [] } });
        assert.equal(cleared.statusCode, 200);

        for (const id of [sc.coding.id, sc.application.id, "00000000-0000-0000-0000-000000000000"]) {
          const res = await chat(app, bare.rawKey, id, alias);
          assert.equal(res.statusCode, 403, `workload ${id}`);
          assert.equal(res.json().error.code, "WORKLOAD_NOT_PERMITTED");
        }
        assert.equal(s.providerCalls(), 0);
        assert.equal(s.vault.decrypts, 0);
        assert.equal(server.requestCount(), 0);
      },
      { credentialVault: s.vault, adapterRegistry: s.registry },
    );
  } finally {
    await server.close();
  }
});

test("a grant change takes effect on the very next request, in both directions", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const sc = await buildScenario(app, pool, server.baseEndpoint);
      const alias = sc.model.inhouseAlias as string;
      const key = sc.keyApplication;

      assert.equal((await chat(app, key.rawKey, sc.coding.id, alias)).statusCode, 403);
      await app.inject({ method: "PUT", url: `/v1/api-keys/${key.apiKey.id}/workloads`, headers: ADMIN, payload: { workloadIds: [sc.application.id, sc.coding.id] } });
      assert.equal((await chat(app, key.rawKey, sc.coding.id, alias)).statusCode, 200);
      await app.inject({ method: "PUT", url: `/v1/api-keys/${key.apiKey.id}/workloads`, headers: ADMIN, payload: { workloadIds: [sc.application.id] } });
      assert.equal((await chat(app, key.rawKey, sc.coding.id, alias)).statusCode, 403);
    });
  } finally {
    await server.close();
  }
});

test("F: a revoked key is refused on every workload it used to be granted", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const sc = await buildScenario(app, pool, server.baseEndpoint);
      const alias = sc.model.inhouseAlias as string;
      assert.equal((await chat(app, sc.keyApplication.rawKey, sc.application.id, alias)).statusCode, 200);
      await app.inject({ method: "DELETE", url: `/v1/api-keys/${sc.keyApplication.apiKey.id}`, headers: ADMIN });
      const after = await chat(app, sc.keyApplication.rawKey, sc.application.id, alias);
      assert.equal(after.statusCode, 401);
      assert.equal(server.requestCount(), 1);
    });
  } finally {
    await server.close();
  }
});

test("G: routing preview never decrypts a credential or contacts a provider, whatever the key grants", async () => {
  const server = await startMockProviderServer("success");
  const s = spies();
  try {
    await withMigratedApp(
      async (app, pool) => {
        await truncateAll(pool, "inhouse");
        const sc = await buildScenario(app, pool, server.baseEndpoint);
        const res = await app.inject({ headers: ADMIN, method: "POST", url: "/v1/routing/preview", payload: { workloadId: sc.coding.id, modelId: sc.model.id } });
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(res.json().decision.outcome, "selected", "the preview did resolve a candidate");
        assert.equal(s.vault.decrypts, 0);
        assert.equal(s.providerCalls(), 0);
        assert.equal(server.requestCount(), 0);
        assert.equal((await new UsageLedgerRepository(pool).listRecent(10)).length, 0);
      },
      { credentialVault: s.vault, adapterRegistry: s.registry },
    );
  } finally {
    await server.close();
  }
});

test("deleting a workload removes its key grants (no dangling permission survives)", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const keep = await createWorkload(pool);
    const drop = await createWorkload(pool);
    const { apiKey } = await createApiKey(app, [keep.id, drop.id]);
    await pool.query("DELETE FROM workloads WHERE id = $1", [drop.id]);
    const listed = (await app.inject({ method: "GET", url: "/v1/api-keys", headers: ADMIN })).json().apiKeys.find((k: { id: string }) => k.id === apiKey.id);
    assert.deepEqual(listed.workloadIds, [keep.id]);
  });
});
