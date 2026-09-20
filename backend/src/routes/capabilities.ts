import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config/index.js";
import { requireAdmin } from "../plugins/adminAuth.js";
import { CapabilitiesRepository } from "../repositories/capabilitiesRepository.js";
import { toCapabilityResponse } from "./serializers.js";

/** Read-only reference-data endpoint — capabilities are data, never hardcoded. */
export function registerCapabilityRoutes(app: FastifyInstance, pool: Pool, config: AppConfig): void {
  const repository = new CapabilitiesRepository(pool);

  app.register(
    async (versioned) => {
      requireAdmin(versioned, config);
      versioned.get("/capabilities", async () => {
        const capabilities = await repository.list();
        return { capabilities: capabilities.map(toCapabilityResponse) };
      });
    },
    { prefix: config.apiPrefix },
  );
}
