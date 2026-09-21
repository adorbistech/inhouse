import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config/index.js";
import { requireAdmin } from "../plugins/adminAuth.js";
import type { CredentialVaultService } from "../lib/credentialVault.js";
import { type AdapterRegistry, createDefaultAdapterRegistry } from "../services/adapters/adapterRegistry.js";
import { ProviderHealthService } from "../services/providerHealthService.js";
import { ProviderVerificationService } from "../services/providerVerificationService.js";
import { requireUuidParam, validateHealthHistoryQuery } from "../validation/providerHealth.js";
import { toProviderHealthEventResponse, toProviderHealthResponse } from "./serializers.js";

/**
 * Health reads, plus one admin-only write: `POST .../verify` (Block 14A).
 * There is deliberately still no endpoint that accepts a caller-supplied
 * observation — recording health over HTTP is only possible by running a
 * real, bounded adapter check (`ProviderVerificationService`), so an
 * account's health can never be fabricated.
 */
export function registerProviderHealthRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: AppConfig,
  credentialVault: CredentialVaultService,
  adapterRegistry: AdapterRegistry = createDefaultAdapterRegistry(),
): void {
  const service = new ProviderHealthService(pool);
  const verification = new ProviderVerificationService(pool, credentialVault, adapterRegistry);

  app.register(
    async (versioned) => {
      requireAdmin(versioned, config);
      versioned.get("/vendors/:id/accounts/:accountId/health", async (request) => {
        const { id, accountId } = request.params as { id: string; accountId: string };
        const health = await service.getCurrentHealth(requireUuidParam(id, "id"), requireUuidParam(accountId, "accountId"));
        return { health: toProviderHealthResponse(accountId, health) };
      });

      versioned.post("/vendors/:id/accounts/:accountId/verify", async (request) => {
        const { id, accountId } = request.params as { id: string; accountId: string };
        const result = await verification.verify(requireUuidParam(id, "id"), requireUuidParam(accountId, "accountId"), {
          actorId: null,
          requestId: request.id,
        });
        return { verification: result };
      });

      versioned.get("/vendors/:id/accounts/:accountId/health/events", async (request) => {
        const { id, accountId } = request.params as { id: string; accountId: string };
        const { limit } = validateHealthHistoryQuery(request.query as Record<string, unknown>);
        const events = await service.getHistory(
          requireUuidParam(id, "id"),
          requireUuidParam(accountId, "accountId"),
          limit,
        );
        return { events: events.map(toProviderHealthEventResponse) };
      });
    },
    { prefix: config.apiPrefix },
  );
}
