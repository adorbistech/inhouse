import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Writable } from "node:stream";
import { ADMIN, TEST_ADMIN_TOKEN, TEST_VAULT_KEY, truncateAll, withMigratedApp, withMigratedPool } from "./helpers.js";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { CredentialVaultService } from "../../src/lib/credentialVault.js";
import { REAL_SECRET, createApiKey, createWorkload, setUpEligibleTier, startMockProviderServer } from "./executionSupport.js";

const ID = "00000000-0000-0000-0000-000000000000";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
interface Probe {
  method: Method;
  url: string;
  payload?: object;
}

/** One representative request per control-plane route (all methods), across every control-plane module. */
const CONTROL_PLANE: Probe[] = [
  { method: "GET", url: "/v1/vendors" },
  { method: "POST", url: "/v1/vendors", payload: {} },
  { method: "GET", url: `/v1/vendors/${ID}` },
  { method: "PATCH", url: `/v1/vendors/${ID}`, payload: {} },
  { method: "DELETE", url: `/v1/vendors/${ID}` },
  { method: "PUT", url: `/v1/vendors/${ID}/capabilities`, payload: { capabilityIds: [] } },
  { method: "PUT", url: `/v1/vendors/${ID}/workloads`, payload: { workloadIds: [] } },
  { method: "GET", url: `/v1/vendors/${ID}/accounts` },
  { method: "POST", url: `/v1/vendors/${ID}/accounts`, payload: {} },
  { method: "PATCH", url: `/v1/vendors/${ID}/accounts/${ID}`, payload: {} },
  { method: "DELETE", url: `/v1/vendors/${ID}/accounts/${ID}` },
  { method: "GET", url: `/v1/vendors/${ID}/credentials` },
  { method: "POST", url: `/v1/vendors/${ID}/credentials`, payload: {} },
  { method: "PATCH", url: `/v1/vendors/${ID}/credentials/${ID}`, payload: {} },
  { method: "DELETE", url: `/v1/vendors/${ID}/credentials/${ID}` },
  { method: "GET", url: `/v1/vendors/${ID}/accounts/${ID}/health` },
  { method: "GET", url: `/v1/vendors/${ID}/accounts/${ID}/health/events` },
  { method: "GET", url: "/v1/models" },
  { method: "POST", url: "/v1/models", payload: {} },
  { method: "GET", url: `/v1/models/${ID}` },
  { method: "PATCH", url: `/v1/models/${ID}`, payload: {} },
  { method: "DELETE", url: `/v1/models/${ID}` },
  { method: "PUT", url: `/v1/models/${ID}/capabilities`, payload: { capabilityIds: [] } },
  { method: "PUT", url: `/v1/models/${ID}/workloads`, payload: { workloadIds: [] } },
  { method: "GET", url: "/v1/capabilities" },
  { method: "GET", url: "/v1/workloads" },
  { method: "GET", url: `/v1/routing/workloads/${ID}` },
  { method: "GET", url: `/v1/routing/workloads/${ID}/tiers` },
  { method: "POST", url: `/v1/routing/workloads/${ID}/tiers`, payload: {} },
  { method: "PATCH", url: `/v1/routing/workloads/${ID}/tiers/${ID}`, payload: {} },
  { method: "DELETE", url: `/v1/routing/workloads/${ID}/tiers/${ID}` },
  { method: "GET", url: `/v1/routing/workloads/${ID}/fallback-rules` },
  { method: "POST", url: `/v1/routing/workloads/${ID}/fallback-rules`, payload: {} },
  { method: "PATCH", url: `/v1/routing/workloads/${ID}/fallback-rules/${ID}`, payload: {} },
  { method: "DELETE", url: `/v1/routing/workloads/${ID}/fallback-rules/${ID}` },
  { method: "POST", url: "/v1/routing/preview", payload: {} },
  { method: "GET", url: "/v1/api-keys" },
  { method: "POST", url: "/v1/api-keys", payload: {} },
  { method: "PUT", url: `/v1/api-keys/${ID}/workloads`, payload: { workloadIds: [] } },
  { method: "DELETE", url: `/v1/api-keys/${ID}` },
  { method: "GET", url: "/v1/usage" },
];

const label = (p: Probe) => `${p.method} ${p.url}`;

test("public health and readiness endpoints work with no credential, even when an admin token is configured", async () => {
  await withMigratedApp(async (app) => {
    for (const url of ["/health", "/v1/health", "/ready", "/v1/ready"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, url);
    }
  });
});

test("every control-plane route (GET/POST/PUT/PATCH/DELETE) rejects a request with no credential with 401", async () => {
  await withMigratedApp(async (app) => {
    for (const p of CONTROL_PLANE) {
      const res = await app.inject({ method: p.method, url: p.url, payload: p.payload });
      assert.equal(res.statusCode, 401, label(p));
      assert.equal(res.json().error.code, "UNAUTHENTICATED", label(p));
    }
  });
});

test("every control-plane route rejects a wrong or malformed credential with 401", async () => {
  await withMigratedApp(async (app) => {
    for (const authorization of ["Bearer wrong-token-value-1234567890abcdef", "Basic abc", "Bearer ", TEST_ADMIN_TOKEN]) {
      for (const p of CONTROL_PLANE) {
        const res = await app.inject({ method: p.method, url: p.url, payload: p.payload, headers: { authorization } });
        // The raw admin token without the Bearer scheme is not a valid credential either.
        assert.equal(res.statusCode, 401, `${label(p)} with "${authorization.slice(0, 12)}"`);
        assert.ok(!res.body.includes("wrong-token-value"));
      }
    }
  });
});

test("with the correct admin token every control-plane route reaches its handler (not 401/503)", async () => {
  await withMigratedApp(async (app) => {
    for (const p of CONTROL_PLANE) {
      const res = await app.inject({ method: p.method, url: p.url, payload: p.payload, headers: ADMIN });
      assert.ok(res.statusCode !== 401 && res.statusCode !== 503, `${label(p)} -> ${res.statusCode}`);
    }
  });
});

test("an unauthenticated caller is rejected before body validation runs (401, not a 400 that leaks schema details)", async () => {
  await withMigratedApp(async (app) => {
    const res = await app.inject({ method: "POST", url: "/v1/vendors", payload: { nonsense: true } });
    assert.equal(res.statusCode, 401);
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/vendors",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    assert.equal(malformed.statusCode, 401);
  });
});

test("provider credentials stay inaccessible through unauthenticated routes; authenticated responses never carry the secret", async () => {
  await withMigratedApp(async (app, pool) => {
    await truncateAll(pool, "inhouse");
    const server = await startMockProviderServer("success");
    try {
      const wl = await createWorkload(pool);
      const { vendor } = await setUpEligibleTier(app, wl.id, server.baseEndpoint);
      for (const url of [`/v1/vendors/${vendor.id}/credentials`, `/v1/vendors/${vendor.id}`, `/v1/vendors/${vendor.id}/accounts`]) {
        const anon = await app.inject({ method: "GET", url });
        assert.equal(anon.statusCode, 401, url);
        assert.ok(!anon.body.includes(REAL_SECRET));
        const authed = await app.inject({ method: "GET", url, headers: ADMIN });
        assert.equal(authed.statusCode, 200, url);
        assert.ok(!authed.body.includes(REAL_SECRET), url);
        assert.ok(!authed.body.includes(TEST_ADMIN_TOKEN), url);
      }
    } finally {
      await server.close();
    }
  });
});

test("the admin token is never echoed in any response, accepted or rejected", async () => {
  await withMigratedApp(async (app) => {
    for (const p of CONTROL_PLANE) {
      for (const headers of [ADMIN, {}]) {
        const res = await app.inject({ method: p.method, url: p.url, payload: p.payload, headers });
        assert.ok(!res.body.includes(TEST_ADMIN_TOKEN), label(p));
        assert.ok(!JSON.stringify(res.headers).includes(TEST_ADMIN_TOKEN), label(p));
      }
    }
  });
});

test("the admin token never appears in logs across accepted and rejected control-plane requests", async () => {
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
      for (const p of CONTROL_PLANE) {
        await app.inject({ method: p.method, url: p.url, payload: p.payload, headers: ADMIN });
        await app.inject({ method: p.method, url: p.url, payload: p.payload });
        await app.inject({ method: p.method, url: p.url, payload: p.payload, headers: { authorization: "Bearer guessed-wrong-admin-token-value-000000" } });
      }
      const output = chunks.join("");
      assert.ok(output.length > 0, "the logger must have captured something");
      assert.ok(!output.includes(TEST_ADMIN_TOKEN));
      assert.ok(!output.includes("guessed-wrong-admin-token-value"));
    } finally {
      await app.close();
    }
  });
});

test("the admin token cannot be used as an execution API key, and an ihk_ key cannot reach the control plane", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const wl = await createWorkload(pool);
      const { model } = await setUpEligibleTier(app, wl.id, server.baseEndpoint);
      const { rawKey } = await createApiKey(app, [wl.id]);
      const body = { workloadId: wl.id, model: model.inhouseAlias, messages: [{ role: "user", content: "hi" }] };

      const before = server.requestCount();
      for (const headers of [{ authorization: `Bearer ${TEST_ADMIN_TOKEN}` }, { "x-api-key": TEST_ADMIN_TOKEN }]) {
        const res = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: body });
        assert.equal(res.statusCode, 401);
      }
      const anthropic = await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": TEST_ADMIN_TOKEN }, payload: body });
      assert.equal(anthropic.statusCode, 401);
      assert.equal(server.requestCount(), before, "no provider request may result from an admin-token execution attempt");

      // The client key holds workload access but is not a control-plane credential — including for
      // routes that could widen its own access (workload/route/key administration).
      const escalation: Probe[] = [
        { method: "PUT", url: `/v1/vendors/${ID}/workloads`, payload: { workloadIds: [wl.id] } },
        { method: "POST", url: `/v1/routing/workloads/${wl.id}/tiers`, payload: {} },
        { method: "POST", url: "/v1/routing/preview", payload: { workloadId: wl.id } },
        { method: "GET", url: "/v1/workloads" },
        { method: "GET", url: "/v1/api-keys" },
      ];
      for (const p of escalation) {
        for (const headers of [{ authorization: `Bearer ${rawKey}` }, { "x-api-key": rawKey }]) {
          const res = await app.inject({ method: p.method, url: p.url, payload: p.payload, headers });
          assert.equal(res.statusCode, 401, label(p));
        }
      }
    });
  } finally {
    await server.close();
  }
});

test("execution with a valid ihk_ key works on a server whose admin token is not configured", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedPool(async (pool, config) => {
      await truncateAll(pool, config.schema);
      const vault = new CredentialVaultService(TEST_VAULT_KEY);
      const adminApp = await buildApp(loadConfig({ INHOUSE_API_ENV: "test", INHOUSE_ADMIN_TOKEN: TEST_ADMIN_TOKEN } as NodeJS.ProcessEnv), { pool, credentialVault: vault });
      const wl = await createWorkload(pool);
      const { model } = await setUpEligibleTier(adminApp, wl.id, server.baseEndpoint);
      const { rawKey } = await createApiKey(adminApp, [wl.id]);
      await adminApp.close();

      const app = await buildApp(loadConfig({ INHOUSE_API_ENV: "test" } as NodeJS.ProcessEnv), { pool, credentialVault: vault });
      try {
        const res = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: { authorization: `Bearer ${rawKey}` },
          payload: { workloadId: wl.id, model: model.inhouseAlias, messages: [{ role: "user", content: "hi" }] },
        });
        assert.equal(res.statusCode, 200, res.body);
        // ...while the control plane on that same server fails closed.
        assert.equal((await app.inject({ method: "GET", url: "/v1/vendors", headers: ADMIN })).statusCode, 503);
        assert.equal((await app.inject({ method: "GET", url: "/v1/vendors" })).statusCode, 503);
        assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
      } finally {
        await app.close();
      }
    });
  } finally {
    await server.close();
  }
});

test("workload scoping is unchanged: a key granted one workload is denied another, and control-plane auth grants nothing to it", async () => {
  const server = await startMockProviderServer("success");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const application = await createWorkload(pool);
      const coding = await createWorkload(pool);
      const { model } = await setUpEligibleTier(app, application.id, server.baseEndpoint);
      const { rawKey } = await createApiKey(app, [application.id]);
      const before = server.requestCount();
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { workloadId: coding.id, model: model.inhouseAlias, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(server.requestCount(), before);
      // Attempting to widen the grant with the client key as the "admin" fails.
      const widen = await app.inject({
        method: "PUT",
        url: "/v1/api-keys/" + ID + "/workloads",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { workloadIds: [coding.id] },
      });
      assert.equal(widen.statusCode, 401);
    });
  } finally {
    await server.close();
  }
});

test("every route module is either a declared public/execution module or guards its whole scope with requireAdmin", () => {
  const dir = join(import.meta.dirname, "..", "..", "src", "routes");
  const NOT_CONTROL_PLANE = new Set(["health.ts", "execution.ts", "executionFormatters.ts", "serializers.ts"]);
  const guarded: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    if (NOT_CONTROL_PLANE.has(file)) continue;
    const source = readFileSync(join(dir, file), "utf8");
    assert.ok(source.includes("requireAdmin(versioned, config)"), `${file} registers routes without the shared admin guard`);
    guarded.push(file);
  }
  assert.ok(guarded.length >= 7, "expected the control-plane route modules to be discovered");
  // Public and execution modules must never take the admin guard (separate trust boundaries).
  for (const file of ["health.ts", "execution.ts"]) {
    assert.ok(!readFileSync(join(dir, file), "utf8").includes("requireAdmin"), `${file} must not use the admin guard`);
  }
});

test("credential decryption boundary is unchanged: only executionService.ts calls getDecryptedCredentialSecret", () => {
  const root = join(import.meta.dirname, "..", "..", "src");
  const callers: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".ts") && readFileSync(p, "utf8").includes("getDecryptedCredentialSecret")) callers.push(p.slice(root.length + 1));
    }
  };
  walk(root);
  assert.deepEqual(callers.sort(), ["services/credentialSecretAccess.ts", "services/executionService.ts"]);
});
