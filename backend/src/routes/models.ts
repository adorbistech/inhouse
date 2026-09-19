import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config/index.js";
import { ModelService } from "../services/modelService.js";
import {
  requireUuidParam,
  validateCreateModelInput,
  validateIdSetBody,
  validateModelListQuery,
  validateModelPatchInput,
} from "../validation/models.js";
import { toCapabilityResponse, toModelDetailResponse, toModelResponse, toWorkloadResponse } from "./serializers.js";

function auditContext(request: FastifyRequest) {
  // No Inhouse authentication exists yet (see docs/API.md) — actorId will
  // be populated once a later block adds real principals.
  return { actorId: null, requestId: request.id };
}

export function registerModelRoutes(app: FastifyInstance, pool: Pool, config: AppConfig): void {
  const service = new ModelService(pool);

  app.register(
    async (versioned) => {
      versioned.get("/models", async (request) => {
        const filters = validateModelListQuery(request.query as Record<string, unknown>);
        const models = await service.list(filters);
        return { models: models.map(toModelResponse) };
      });

      versioned.get("/models/:id", async (request) => {
        const { id } = request.params as { id: string };
        const model = await service.getDetail(requireUuidParam(id, "id"));
        return { model: toModelDetailResponse(model) };
      });

      versioned.post("/models", async (request, reply) => {
        const input = validateCreateModelInput(request.body);
        const model = await service.create(input, auditContext(request));
        reply.code(201);
        return { model: toModelDetailResponse(model) };
      });

      versioned.patch("/models/:id", async (request) => {
        const { id } = request.params as { id: string };
        const patch = validateModelPatchInput(request.body);
        const model = await service.update(requireUuidParam(id, "id"), patch, auditContext(request));
        return { model: toModelDetailResponse(model) };
      });

      versioned.delete("/models/:id", async (request) => {
        const { id } = request.params as { id: string };
        const model = await service.setStatus(requireUuidParam(id, "id"), "disabled", auditContext(request));
        return { model: toModelDetailResponse(model) };
      });

      versioned.put("/models/:id/capabilities", async (request) => {
        const { id } = request.params as { id: string };
        const capabilityIds = validateIdSetBody(request.body, "capabilityIds");
        const capabilities = await service.setCapabilities(
          requireUuidParam(id, "id"),
          capabilityIds,
          auditContext(request),
        );
        return { capabilities: capabilities.map(toCapabilityResponse) };
      });

      versioned.put("/models/:id/workloads", async (request) => {
        const { id } = request.params as { id: string };
        const workloadIds = validateIdSetBody(request.body, "workloadIds");
        const workloads = await service.setWorkloads(
          requireUuidParam(id, "id"),
          workloadIds,
          auditContext(request),
        );
        return { workloads: workloads.map(toWorkloadResponse) };
      });
    },
    { prefix: config.apiPrefix },
  );
}
