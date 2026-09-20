import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { TEST_ADMIN_TOKEN, TEST_VAULT_KEY, truncateAll, withMigratedApp, withMigratedPool } from "./helpers.js";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { CredentialVaultService } from "../../src/lib/credentialVault.js";
import { ADMIN, REAL_SECRET, createApiKey, createWorkload, setUpEligibleTier, startMockProviderServer } from "./executionSupport.js";

const GUARDED: Array<{ method: "GET" | "POST" | "DELETE" | "PUT"; url: string; payload?: unknown }> = [
  { method: "GET", url: "/v1/api-keys" },
  { method: "POST", url: "/v1/api-keys", payload: { name: "x", workloadIds: ["00000000-0000-0000-0000-000000000000"] } },
  { method: "PUT", url: "/v1/api-keys/00000000-0000-0000-0000-000000000000/workloads", payload: { workloadIds: [] } },
  { method: "DELETE", url: "/v1/api-keys/00000000-0000-0000-0000-000000000000" },
  { method: "GET", url: "/v1/usage" },
];

test("every admin route rejects a request with no administrative credential", async () => {
  await withMigratedApp(async (app) => {
    for (const r of GUARDED) {
      const res = await app.inject({ method: r.method, url: r.url, payload: r.payload as object });
      assert.equal(res.statusCode, 401, `${r.method} ${r.url}`);
      assert.equal(res.json().error.code, "UNAUTHENTICATED");
    }
  });
});

test("every admin route rejects a wrong administrative credential, without echoing it", async () => {
  await withMigratedApp(async (app) => {
    for (const r of GUARDED) {
      const res = await app.inject({ method: r.method, url: r.url, payload: r.payload as object, headers: { authorization: "Bearer wrong-token-value-1234567890abcdef" } });
      assert.equal(res.statusCode, 401, `${r.method} ${r.url}`);
      assert.ok(!res.body.includes("wrong-token-value"));
    }
  });
});

test("the valid administrative credential is accepted on every admin route", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const wl = await createWorkload(pool);
    const created = await app.inject({ method: "POST", url: "/v1/api-keys", headers: ADMIN, payload: { name: "k", workloadIds: [wl.id] } });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().apiKey.id as string;
    assert.deepEqual(created.json().apiKey.workloadIds, [wl.id]);
    assert.equal((await app.inject({ method: "GET", url: "/v1/api-keys", headers: ADMIN })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/v1/usage", headers: ADMIN })).statusCode, 200);
    assert.equal((await app.inject({ method: "PUT", url: `/v1/api-keys/${id}/workloads`, headers: ADMIN, payload: { workloadIds: [] } })).statusCode, 200);
    assert.equal((await app.inject({ method: "DELETE", url: `/v1/api-keys/${id}`, headers: ADMIN })).statusCode, 200);
  });
});

test("a client execution key cannot authenticate as an administrator", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const wl = await createWorkload(pool);
    const { rawKey } = await createApiKey(app, [wl.id]);
    for (const r of GUARDED) {
      const viaBearer = await app.inject({ method: r.method, url: r.url, payload: r.payload as object, headers: { authorization: `Bearer ${rawKey}` } });
      assert.equal(viaBearer.statusCode, 401, `${r.method} ${r.url}`);
      const viaApiKeyHeader = await app.inject({ method: r.method, url: r.url, payload: r.payload as object, headers: { "x-api-key": rawKey } });
      assert.equal(viaApiKeyHeader.statusCode, 401);
    }
  });
});

test("a provider credential cannot authenticate as an administrator", async () => {
  await withMigratedApp(async (app) => {
    for (const r of GUARDED) {
      const res = await app.inject({ method: r.method, url: r.url, payload: r.payload as object, headers: { authorization: `Bearer ${REAL_SECRET}` } });
      assert.equal(res.statusCode, 401, `${r.method} ${r.url}`);
    }
  });
});

test("the admin token never appears in logs — for accepted, rejected and guessed-wrong attempts", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedPool(async (pool, config) => {
      await truncateAll(pool, config.schema);
      const chunks: string[] = [];
      const app = await buildApp(loadConfig({ INHOUSE_API_ENV: "test", INHOUSE_ADMIN_TOKEN: TEST_ADMIN_TOKEN } as NodeJS.ProcessEnv), {
        pool,
        credentialVault: new CredentialVaultService(TEST_VAULT_KEY),
        loggerStream: new Writable({
          write(chunk: Buffer, _enc, cb) {
            chunks.push(chunk.toString());
            cb();
          },
        }),
      });
      try {
        const wl = await createWorkload(pool);
        await setUpEligibleTier(app, wl.id, server.baseEndpoint);
        await createApiKey(app, [wl.id]);
        await app.inject({ method: "GET", url: "/v1/api-keys", headers: ADMIN });
        await app.inject({ method: "GET", url: "/v1/api-keys", headers: { authorization: "Bearer guessed-wrong-admin-token-value-000000" } });
        const output = chunks.join("");
        assert.ok(!output.includes(TEST_ADMIN_TOKEN));
        assert.ok(!output.includes("guessed-wrong-admin-token-value"));
      } finally {
        await app.close();
      }
    });
  } finally {
    await server.close();
  }
});

test("with no administrative token configured the admin routes fail closed (503), never open", async () => {
  await withMigratedPool(async (pool, config) => {
    await truncateAll(pool, config.schema);
    const app = await buildApp(loadConfig({ INHOUSE_API_ENV: "test" } as NodeJS.ProcessEnv), {
      pool,
      credentialVault: new CredentialVaultService(TEST_VAULT_KEY),
    });
    try {
      for (const headers of [{}, ADMIN, { authorization: "Bearer " }]) {
        const res = await app.inject({ method: "GET", url: "/v1/api-keys", headers });
        assert.equal(res.statusCode, 503);
        assert.equal(res.json().error.code, "ADMIN_AUTH_NOT_CONFIGURED");
      }
    } finally {
      await app.close();
    }
  });
});

test("key creation requires an explicit, existing workload grant (default deny) and the grant set can be replaced", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const wlA = await createWorkload(pool);
    const wlB = await createWorkload(pool);

    const none = await app.inject({ method: "POST", url: "/v1/api-keys", headers: ADMIN, payload: { name: "k" } });
    assert.equal(none.statusCode, 400);
    const empty = await app.inject({ method: "POST", url: "/v1/api-keys", headers: ADMIN, payload: { name: "k", workloadIds: [] } });
    assert.equal(empty.statusCode, 400);
    const ghost = await app.inject({ method: "POST", url: "/v1/api-keys", headers: ADMIN, payload: { name: "k", workloadIds: ["00000000-0000-0000-0000-000000000000"] } });
    assert.equal(ghost.statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/v1/api-keys", headers: ADMIN })).json().apiKeys.length, 0, "a rejected create must not leave a key behind");

    const created = await app.inject({ method: "POST", url: "/v1/api-keys", headers: ADMIN, payload: { name: "k", workloadIds: [wlA.id, wlA.id] } });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(created.json().apiKey.workloadIds, [wlA.id]);
    const id = created.json().apiKey.id as string;

    const replaced = await app.inject({ method: "PUT", url: `/v1/api-keys/${id}/workloads`, headers: ADMIN, payload: { workloadIds: [wlB.id] } });
    assert.equal(replaced.statusCode, 200);
    const listed = (await app.inject({ method: "GET", url: "/v1/api-keys", headers: ADMIN })).json().apiKeys[0];
    assert.deepEqual(listed.workloadIds, [wlB.id]);

    const badPut = await app.inject({ method: "PUT", url: `/v1/api-keys/${id}/workloads`, headers: ADMIN, payload: { workloadIds: ["00000000-0000-0000-0000-000000000000"] } });
    assert.equal(badPut.statusCode, 400);
    assert.deepEqual((await app.inject({ method: "GET", url: "/v1/api-keys", headers: ADMIN })).json().apiKeys[0].workloadIds, [wlB.id]);
  });
});
