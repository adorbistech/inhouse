import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config/index.js";
import { WorkloadsRepository } from "../repositories/workloadsRepository.js";
import { toWorkloadResponse } from "./serializers.js";

/** Read-only reference-data endpoint — workloads are data, never hardcoded. */
export function registerWorkloadRoutes(app: FastifyInstance, pool: Pool, config: AppConfig): void {
  const repository = new WorkloadsRepository(pool);

  app.register(
    async (versioned) => {
      versioned.get("/workloads", async () => {
        const workloads = await repository.list();
        return { workloads: workloads.map(toWorkloadResponse) };
      });
    },
    { prefix: config.apiPrefix },
  );
}
