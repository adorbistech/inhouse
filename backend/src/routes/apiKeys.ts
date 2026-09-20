import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config/index.js";
import { withTransaction } from "../db/client.js";
import { generateApiKey } from "../lib/apiKeyGenerator.js";
import { NotFoundError, ValidationError } from "../lib/httpErrors.js";
import { requireAdmin } from "../plugins/adminAuth.js";
import { ApiKeysRepository } from "../repositories/apiKeysRepository.js";
import { UsageLedgerRepository } from "../repositories/usageLedgerRepository.js";
import { WorkloadsRepository } from "../repositories/workloadsRepository.js";
import { requireUuidParam, validateCreateApiKeyInput, validateSetWorkloadsInput } from "../validation/apiKeys.js";
import { toApiKeyResponse, toUsageLedgerResponse } from "./serializers.js";

/**
 * Control-plane management of Inhouse-issued client API keys (Block 12) —
 * distinct from, and never touching, provider credentials (Block 08's
 * `vendor_credentials`/`credentialSecretAccess.ts`).
 *
 * Every route here requires the administrative token
 * (`plugins/adminAuth.ts`, `INHOUSE_ADMIN_TOKEN`): minting a client key is
 * what grants the ability to spend provider quota, so it must never be
 * reachable anonymously. A client execution key cannot authenticate here.
 */
export function registerApiKeyRoutes(app: FastifyInstance, pool: Pool, config: AppConfig): void {
  const repo = new ApiKeysRepository(pool);
  const usageLedger = new UsageLedgerRepository(pool);
  const workloads = new WorkloadsRepository(pool);

  async function requireExistingWorkloads(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (!(await workloads.findById(id))) {
        throw new ValidationError(`Workload "${id}" was not found.`);
      }
    }
  }

  app.register(
    async (versioned) => {
      requireAdmin(versioned, config);
      versioned.get("/api-keys", async () => {
        const [keys, grants] = await Promise.all([repo.list(), repo.listWorkloadIdsByKey()]);
        return { apiKeys: keys.map((k) => toApiKeyResponse(k, grants.get(k.id) ?? [])) };
      });

      /**
       * The only place the raw key is ever returned — `rawKey` appears in
       * this one response body and nowhere else, ever again. The caller
       * must store it themselves; Inhouse never persists or displays it
       * again (mirrors Block 08's "never shown again" managed-secret
       * behavior for provider credentials).
       */
      versioned.post("/api-keys", async (request, reply) => {
        const input = validateCreateApiKeyInput(request.body);
        await requireExistingWorkloads(input.workloadIds);
        const { keyId, rawKey } = generateApiKey();
        const created = await withTransaction(pool, async (client) => {
          const txRepo = new ApiKeysRepository(client);
          const row = await txRepo.createWithRawKey(rawKey, {
            keyId,
            name: input.name,
            permissions: [],
            status: "active",
            expiresAt: input.expiresAt,
          });
          await txRepo.replaceWorkloads(row.id, input.workloadIds);
          return row;
        });
        reply.code(201);
        return { apiKey: toApiKeyResponse(created, input.workloadIds), rawKey };
      });

      versioned.put("/api-keys/:id/workloads", async (request) => {
        const { id } = request.params as { id: string };
        const keyId = requireUuidParam(id, "id");
        const workloadIds = validateSetWorkloadsInput(request.body);
        const existing = await repo.findById(keyId);
        if (!existing) {
          throw new NotFoundError(`Api key "${id}" was not found.`);
        }
        await requireExistingWorkloads(workloadIds);
        await withTransaction(pool, (client) => new ApiKeysRepository(client).replaceWorkloads(keyId, workloadIds));
        return { apiKey: toApiKeyResponse(existing, workloadIds) };
      });

      versioned.delete("/api-keys/:id", async (request) => {
        const { id } = request.params as { id: string };
        const updated = await repo.setStatus(requireUuidParam(id, "id"), "revoked");
        if (!updated) {
          throw new NotFoundError(`Api key "${id}" was not found.`);
        }
        return { apiKey: toApiKeyResponse(updated, await repo.listWorkloadIds(updated.id)) };
      });

      /**
       * Read-only execution/usage telemetry (Block 12) — never a secret,
       * never a credential, never a raw request/response body (see
       * migration 0008/0013's comments and `services/executionService.ts`).
       */
      versioned.get("/usage", async (request) => {
        const query = request.query as { limit?: string };
        const limit = query.limit ? Number(query.limit) : 100;
        const entries = await usageLedger.listRecent(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 100);
        return { usage: entries.map(toUsageLedgerResponse) };
      });
    },
    { prefix: config.apiPrefix },
  );
}
