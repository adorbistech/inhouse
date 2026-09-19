import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { withMigratedApp, truncateAll, TEST_VAULT_KEY } from "./helpers.js";
import { CredentialVaultService } from "../../src/lib/credentialVault.js";
import { getDecryptedCredentialSecret } from "../../src/services/credentialSecretAccess.js";
import { ProviderHealthService } from "../../src/services/providerHealthService.js";
import { OpenAiCompatibleAdapter } from "../../src/services/adapters/openAiCompatibleAdapter.js";

/**
 * End-to-end proof that the Block 10 adapter boundary composes correctly
 * with Block 08 (credential vault) and Block 09 (health service) without
 * any of them being modified: decrypt via `getDecryptedCredentialSecret`,
 * run a real (local, disposable) HTTP round trip through
 * `OpenAiCompatibleAdapter.checkHealth`, and persist via
 * `ProviderHealthService.recordObservation`. No route in this codebase
 * wires this together — this test is the only caller, exactly like Block
 * 09's own tests call `ProviderHealthService` directly. See
 * docs/PROVIDER_ADAPTERS.md.
 */

const REAL_SECRET = "sk-live-test-secret-must-never-appear-in-any-response-or-log";

async function startMockProviderServer(behavior: "healthy" | "unauthorized" | "slow"): Promise<{
  baseEndpoint: string;
  close: () => Promise<void>;
  receivedAuthHeaders: string[];
}> {
  const receivedAuthHeaders: string[] = [];
  const server = createServer((req, res) => {
    receivedAuthHeaders.push(req.headers.authorization ?? "");
    if (behavior === "unauthorized") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid api key" }));
      return;
    }
    if (behavior === "slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
      }, 2000);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "gpt-test" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseEndpoint: `http://127.0.0.1:${port}`,
    receivedAuthHeaders,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function setUpVendorAccountAndManagedCredential(app: import("fastify").FastifyInstance, baseEndpoint: string) {
  const vendor = (
    await app.inject({
      method: "POST",
      url: "/v1/vendors",
      payload: {
        slug: "adapter-health-vendor",
        displayName: "Adapter Health Vendor",
        vendorType: "general_api",
        protocol: "openai-compatible",
        baseEndpoint,
        billingType: "metered",
        timeoutMs: 1000,
      },
    })
  ).json().vendor;
  const account = (
    await app.inject({
      method: "POST",
      url: `/v1/vendors/${vendor.id}/accounts`,
      payload: { slug: "primary", displayName: "Primary Account" },
    })
  ).json().account;
  const credential = (
    await app.inject({
      method: "POST",
      url: `/v1/vendors/${vendor.id}/credentials`,
      payload: { vendorAccountId: account.id, credentialType: "api_key", secret: REAL_SECRET },
    })
  ).json().credential;
  return { vendor, account, credential };
}

test("adapter checkHealth() + credentialSecretAccess + ProviderHealthService compose into a real, successful health observation", async () => {
  const server = await startMockProviderServer("healthy");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const { vendor, account, credential } = await setUpVendorAccountAndManagedCredential(app, server.baseEndpoint);

      const vault = new CredentialVaultService(TEST_VAULT_KEY);
      const secret = await getDecryptedCredentialSecret(pool, vault, credential.id);
      assert.equal(secret, REAL_SECRET);

      const adapter = new OpenAiCompatibleAdapter();
      const result = await adapter.checkHealth(secret, { baseEndpoint: vendor.baseEndpoint, timeoutMs: 1000 });
      assert.equal(result.status, "healthy");

      const health = new ProviderHealthService(pool);
      await health.recordObservation(vendor.id, account.id, {
        status: result.status,
        latencyMs: result.latencyMs,
        errorCategory: result.errorCategory,
        safeErrorCode: result.safeErrorCode,
        source: "adapter",
        checkedAt: new Date(),
      });

      const healthRes = await app.inject({ method: "GET", url: `/v1/vendors/${vendor.id}/accounts/${account.id}/health` });
      assert.equal(healthRes.json().health.status, "healthy");

      assert.equal(server.receivedAuthHeaders[0], `Bearer ${REAL_SECRET}`);
    });
  } finally {
    await server.close();
  }
});

test("an unauthorized provider response becomes a normalized 'authentication' health failure, never a raw provider body", async () => {
  const server = await startMockProviderServer("unauthorized");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const { vendor, account, credential } = await setUpVendorAccountAndManagedCredential(app, server.baseEndpoint);

      const vault = new CredentialVaultService(TEST_VAULT_KEY);
      const secret = await getDecryptedCredentialSecret(pool, vault, credential.id);
      const adapter = new OpenAiCompatibleAdapter();
      const result = await adapter.checkHealth(secret, { baseEndpoint: vendor.baseEndpoint, timeoutMs: 1000 });

      assert.equal(result.status, "unhealthy");
      assert.equal(result.errorCategory, "authentication");
      assert.equal(result.safeErrorCode, "401");

      const health = new ProviderHealthService(pool);
      await health.recordObservation(vendor.id, account.id, {
        status: result.status,
        latencyMs: result.latencyMs,
        errorCategory: result.errorCategory,
        safeErrorCode: result.safeErrorCode,
        source: "adapter",
        checkedAt: new Date(),
      });
      const eventsRes = await app.inject({
        method: "GET",
        url: `/v1/vendors/${vendor.id}/accounts/${account.id}/health/events`,
      });
      const body = JSON.stringify(eventsRes.json());
      assert.ok(!body.includes(REAL_SECRET));
      assert.ok(!body.includes("invalid api key"));
    });
  } finally {
    await server.close();
  }
});

test("a real network timeout against a slow provider is categorized as 'timeout', bounded by the vendor's configured timeoutMs", async () => {
  const server = await startMockProviderServer("slow");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const { vendor, credential } = await setUpVendorAccountAndManagedCredential(app, server.baseEndpoint);

      const vault = new CredentialVaultService(TEST_VAULT_KEY);
      const secret = await getDecryptedCredentialSecret(pool, vault, credential.id);
      const adapter = new OpenAiCompatibleAdapter();
      const start = Date.now();
      const result = await adapter.checkHealth(secret, { baseEndpoint: vendor.baseEndpoint, timeoutMs: 150 });
      const elapsed = Date.now() - start;

      assert.equal(result.status, "unhealthy");
      assert.equal(result.errorCategory, "timeout");
      // Bounded by the configured timeout, not by the mock server's 2s delay.
      assert.ok(elapsed < 1000, `expected the call to abort near 150ms, took ${elapsed}ms`);
    });
  } finally {
    await server.close();
  }
});

test("disabling a credential makes it unusable for a health check, exactly as Block 08 guarantees", async () => {
  const server = await startMockProviderServer("healthy");
  try {
    await withMigratedApp(async (app, pool) => {
      await truncateAll(pool, "inhouse");
      const { vendor, credential } = await setUpVendorAccountAndManagedCredential(app, server.baseEndpoint);
      await app.inject({
        method: "PATCH",
        url: `/v1/vendors/${vendor.id}/credentials/${credential.id}`,
        payload: { status: "disabled" },
      });

      const vault = new CredentialVaultService(TEST_VAULT_KEY);
      await assert.rejects(() => getDecryptedCredentialSecret(pool, vault, credential.id));
    });
  } finally {
    await server.close();
  }
});
