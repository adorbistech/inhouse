import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ADMIN } from "./helpers.js";
import { WorkloadsRepository } from "../../src/repositories/workloadsRepository.js";

export const REAL_SECRET = "sk-live-execution-test-secret-must-never-leak";

export type MockBehavior =
  | "success"
  | "unauthorized"
  | "rateLimit"
  | "serverError"
  | "slow"
  | "malformed"
  | "flaky"
  | "toolCall"
  | "stream"
  | "streamTool"
  | "streamTruncated"
  | "streamHang"
  | "streamMidError"
  | "hang";

export interface MockProvider {
  baseEndpoint: string;
  close: () => Promise<void>;
  requestCount: () => number;
  /** Requests whose connection the client closed before the mock finished answering. */
  abortedCount: () => number;
  receivedAuthHeaders: string[];
  receivedBodies: unknown[];
}

const sseChunk = (data: unknown): string => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
  id: "provider-stream-1",
  model: "provider-model-x",
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});

/** A disposable local HTTP server standing in for a real provider's OpenAI-compatible API — never a real network call. */
export async function startMockProviderServer(behavior: MockBehavior): Promise<MockProvider> {
  let count = 0;
  let aborted = 0;
  let flakyFailuresLeft = 2;
  const receivedAuthHeaders: string[] = [];
  const receivedBodies: unknown[] = [];

  const server = createServer((req, res) => {
    count++;
    receivedAuthHeaders.push(req.headers.authorization ?? "");
    res.on("close", () => {
      if (!res.writableFinished) aborted++;
    });
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let parsed: { stream?: boolean } | null = null;
      try {
        parsed = JSON.parse(raw) as { stream?: boolean };
      } catch {
        parsed = null;
      }
      if (req.url?.includes("/chat/completions")) receivedBodies.push(parsed);
      respond(parsed?.stream === true);
    });

    function json(status: number, body: unknown): void {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    }
    function sseHead(): void {
      res.writeHead(200, { "content-type": "text/event-stream" });
    }

    function respond(wantsStream: boolean): void {
      if (behavior === "unauthorized") return json(401, { error: "invalid api key, please check your credentials" });
      if (behavior === "rateLimit") return json(429, { error: "rate limited" });
      if (behavior === "serverError") return json(500, { error: "internal provider error" });
      if (behavior === "malformed") return json(200, { unexpected: "shape" });
      if (behavior === "hang") return; // never answers; the test closes the client side
      if (behavior === "slow") {
        setTimeout(() => {
          if (res.writableEnded || res.destroyed) return;
          json(200, { id: "resp-1", choices: [{ message: { content: "late" }, finish_reason: "stop" }] });
        }, 2000);
        return;
      }
      if (behavior === "flaky" && flakyFailuresLeft > 0) {
        flakyFailuresLeft--;
        return json(500, { error: "transient" });
      }
      if (behavior === "toolCall") {
        return json(200, {
          id: "provider-resp-tool",
          model: "provider-model-x",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
        });
      }
      if (wantsStream) {
        sseHead();
        if (behavior === "streamTool") {
          res.write(sseChunk(delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] })));
          res.write(sseChunk(delta({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] })));
          res.write(sseChunk(delta({ tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] })));
          res.write(sseChunk(delta({}, "tool_calls")));
          res.write(sseChunk({ id: "provider-stream-1", choices: [], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } }));
          res.end(sseChunk("[DONE]"));
          return;
        }
        if (behavior === "streamTruncated") {
          res.end(sseChunk(delta({ content: "partial" })));
          return;
        }
        if (behavior === "streamHang") {
          res.write(sseChunk(delta({ content: "first" })));
          return; // stays open
        }
        if (behavior === "streamMidError") {
          res.write(sseChunk(delta({ content: "first" })));
          setTimeout(() => res.destroy(), 20);
          return;
        }
        res.write(sseChunk(delta({ role: "assistant", content: "" })));
        res.write(sseChunk(delta({ content: "Hello " })));
        res.write(sseChunk(delta({ content: "stream" })));
        res.write(sseChunk(delta({}, "stop")));
        res.write(sseChunk({ id: "provider-stream-1", choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }));
        res.end(sseChunk("[DONE]"));
        return;
      }
      json(200, {
        id: "provider-resp-1",
        model: "provider-model-x",
        choices: [{ message: { content: "Hello from the mock provider." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseEndpoint: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    requestCount: () => count,
    abortedCount: () => aborted,
    receivedAuthHeaders,
    receivedBodies,
  };
}

export async function createWorkload(pool: Pool, overrides: Record<string, unknown> = {}) {
  return new WorkloadsRepository(pool).create({
    slug: `workload-${Math.random().toString(36).slice(2, 8)}`,
    display_name: "Execution Workload",
    description: null,
    status: "enabled",
    ...overrides,
  });
}

export async function createVendor(app: FastifyInstance, baseEndpoint: string, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({ headers: ADMIN,
    method: "POST",
    url: "/v1/vendors",
    payload: {
      slug: `vendor-${Math.random().toString(36).slice(2, 8)}`,
      displayName: "Execution Vendor",
      vendorType: "general_api",
      protocol: "openai-compatible",
      baseEndpoint,
      billingType: "metered",
      timeoutMs: 1000,
      retryMaxAttempts: 1,
      retryBackoffMs: 5,
      automaticFallback: false,
      ...overrides,
    },
  });
  assert.equal(res.statusCode, 201, `createVendor failed: ${res.body}`);
  return res.json().vendor;
}

export async function createModel(app: FastifyInstance, vendorId: string, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({ headers: ADMIN,
    method: "POST",
    url: "/v1/models",
    payload: {
      vendorId,
      providerModelId: "provider-model-x",
      inhouseAlias: `alias-${Math.random().toString(36).slice(2, 8)}`,
      displayName: "Execution Model",
      status: "enabled",
      ...overrides,
    },
  });
  assert.equal(res.statusCode, 201, `createModel failed: ${res.body}`);
  return res.json().model;
}

export async function attachVendorToWorkload(app: FastifyInstance, vendorId: string, workloadId: string) {
  const res = await app.inject({ headers: ADMIN, method: "PUT", url: `/v1/vendors/${vendorId}/workloads`, payload: { workloadIds: [workloadId] } });
  assert.equal(res.statusCode, 200, `attachVendorToWorkload failed: ${res.body}`);
}

export async function attachModelToWorkload(app: FastifyInstance, modelId: string, workloadId: string) {
  const res = await app.inject({ headers: ADMIN, method: "PUT", url: `/v1/models/${modelId}/workloads`, payload: { workloadIds: [workloadId] } });
  assert.equal(res.statusCode, 200, `attachModelToWorkload failed: ${res.body}`);
}

export async function createAccountAndCredential(app: FastifyInstance, vendorId: string, secret = REAL_SECRET) {
  const account = (
    await app.inject({ headers: ADMIN, method: "POST", url: `/v1/vendors/${vendorId}/accounts`, payload: { slug: "primary", displayName: "Primary" } })
  ).json().account;
  const credential = (
    await app.inject({ headers: ADMIN,
      method: "POST",
      url: `/v1/vendors/${vendorId}/credentials`,
      payload: { vendorAccountId: account.id, credentialType: "api_key", secret },
    })
  ).json().credential;
  return { account, credential };
}

export async function createTier(app: FastifyInstance, workloadId: string, vendorId: string, modelId: string, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({ headers: ADMIN,
    method: "POST",
    url: `/v1/routing/workloads/${workloadId}/tiers`,
    payload: { vendorId, modelId, tierNumber: 0, priority: 0, enabled: true, ...overrides },
  });
  assert.equal(res.statusCode, 201, `createTier failed: ${res.body}`);
  return res.json().tier;
}

export { ADMIN };

export async function createApiKey(app: FastifyInstance, workloadIds: string[]): Promise<{ rawKey: string; apiKey: { id: string } }> {
  const res = await app.inject({ method: "POST", url: "/v1/api-keys", headers: ADMIN, payload: { name: "test-key", workloadIds } });
  assert.equal(res.statusCode, 201, `createApiKey failed: ${res.body}`);
  const body = res.json();
  return { rawKey: body.rawKey, apiKey: body.apiKey };
}

/**
 * One eligible tier, end to end: vendor (pointed at `server.baseEndpoint`)
 * + account + managed credential + model, both vendor and model attached
 * to `workloadId`, and one routing tier connecting them.
 */
export async function setUpEligibleTier(
  app: FastifyInstance,
  workloadId: string,
  baseEndpoint: string,
  opts: { vendorOverrides?: Record<string, unknown>; secret?: string } = {},
) {
  const vendor = await createVendor(app, baseEndpoint, opts.vendorOverrides);
  const model = await createModel(app, vendor.id);
  await attachVendorToWorkload(app, vendor.id, workloadId);
  await attachModelToWorkload(app, model.id, workloadId);
  const { account, credential } = await createAccountAndCredential(app, vendor.id, opts.secret);
  const tier = await createTier(app, workloadId, vendor.id, model.id);
  return { vendor, model, account, credential, tier };
}

