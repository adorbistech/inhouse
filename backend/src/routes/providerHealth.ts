import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config/index.js";
import { requireAdmin } from "../plugins/adminAuth.js";
import { ProviderHealthService } from "../services/providerHealthService.js";
import { requireUuidParam, validateHealthHistoryQuery } from "../validation/providerHealth.js";
import { toProviderHealthEventResponse, toProviderHealthResponse } from "./serializers.js";

/**
 * Read-only. There is deliberately no write endpoint here in Block 09 —
 * see docs/PROVIDER_HEALTH.md. Recording an observation
 * (`ProviderHealthService.recordObservation`) is reserved for a future,
 * trusted provider adapter to call directly; exposing it over HTTP today
 * would let any caller fabricate an account's health with no real check
 * behind it.
 */
export function registerProviderHealthRoutes(app: FastifyInstance, pool: Pool, config: AppConfig): void {
  const service = new ProviderHealthService(pool);

  app.register(
    async (versioned) => {
      requireAdmin(versioned, config);
      versioned.get("/vendors/:id/accounts/:accountId/health", async (request) => {
        const { id, accountId } = request.params as { id: string; accountId: string };
        const health = await service.getCurrentHealth(requireUuidParam(id, "id"), requireUuidParam(accountId, "accountId"));
        return { health: toProviderHealthResponse(accountId, health) };
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
