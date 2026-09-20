import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config/index.js";
import { RoutingService } from "../services/routingService.js";
import {
  requireUuidParam,
  validateCreateRoutingFallbackRuleInput,
  validateCreateRoutingTierInput,
  validateRoutingFallbackRulePatchInput,
  validateRoutingPreviewInput,
  validateRoutingTierPatchInput,
} from "../validation/routing.js";
import {
  toRoutingDecisionResponse,
  toRoutingFallbackRuleResponse,
  toRoutingTierResponse,
  toWorkloadResponse,
} from "./serializers.js";

function auditContext(request: FastifyRequest) {
  // No Inhouse authentication exists yet (see docs/API.md) — actorId will
  // be populated once a later block adds real principals.
  return { actorId: null, requestId: request.id };
}

/**
 * Block 11 — Routing Policy & Deterministic Selection Foundation. Every
 * handler here either reads existing routing/vendor/model/workload
 * configuration and observed health, or manages `routing_tiers`/
 * `routing_fallback_rules` rows through `RoutingRepository` (Block 05,
 * unchanged). Nothing here calls a provider, decrypts a credential, or
 * writes to the usage ledger or a health event — see
 * `services/routingService.ts` and docs/ROUTING_POLICY.md.
 */
export function registerRoutingRoutes(app: FastifyInstance, pool: Pool, config: AppConfig): void {
  const service = new RoutingService(pool);

  app.register(
    async (versioned) => {
      versioned.get("/routing/workloads/:workloadId", async (request) => {
        const { workloadId } = request.params as { workloadId: string };
        const { workload, tiers, fallbackRules } = await service.getWorkloadRoutingConfig(
          requireUuidParam(workloadId, "workloadId"),
        );
        return {
          workload: toWorkloadResponse(workload),
          tiers: tiers.map(toRoutingTierResponse),
          fallbackRules: fallbackRules.map(toRoutingFallbackRuleResponse),
        };
      });

      versioned.get("/routing/workloads/:workloadId/tiers", async (request) => {
        const { workloadId } = request.params as { workloadId: string };
        const tiers = await service.listTiers(requireUuidParam(workloadId, "workloadId"));
        return { tiers: tiers.map(toRoutingTierResponse) };
      });

      versioned.post("/routing/workloads/:workloadId/tiers", async (request, reply) => {
        const { workloadId } = request.params as { workloadId: string };
        const input = validateCreateRoutingTierInput(request.body);
        const tier = await service.createTier(requireUuidParam(workloadId, "workloadId"), input, auditContext(request));
        reply.code(201);
        return { tier: toRoutingTierResponse(tier) };
      });

      versioned.patch("/routing/workloads/:workloadId/tiers/:tierId", async (request) => {
        const { workloadId, tierId } = request.params as { workloadId: string; tierId: string };
        const patch = validateRoutingTierPatchInput(request.body);
        const tier = await service.updateTier(
          requireUuidParam(workloadId, "workloadId"),
          requireUuidParam(tierId, "tierId"),
          patch,
          auditContext(request),
        );
        return { tier: toRoutingTierResponse(tier) };
      });

      versioned.delete("/routing/workloads/:workloadId/tiers/:tierId", async (request) => {
        const { workloadId, tierId } = request.params as { workloadId: string; tierId: string };
        const tier = await service.setTierEnabled(
          requireUuidParam(workloadId, "workloadId"),
          requireUuidParam(tierId, "tierId"),
          false,
          auditContext(request),
        );
        return { tier: toRoutingTierResponse(tier) };
      });

      versioned.get("/routing/workloads/:workloadId/fallback-rules", async (request) => {
        const { workloadId } = request.params as { workloadId: string };
        const rules = await service.listFallbackRules(requireUuidParam(workloadId, "workloadId"));
        return { fallbackRules: rules.map(toRoutingFallbackRuleResponse) };
      });

      versioned.post("/routing/workloads/:workloadId/fallback-rules", async (request, reply) => {
        const { workloadId } = request.params as { workloadId: string };
        const input = validateCreateRoutingFallbackRuleInput(request.body);
        const rule = await service.createFallbackRule(
          requireUuidParam(workloadId, "workloadId"),
          input,
          auditContext(request),
        );
        reply.code(201);
        return { fallbackRule: toRoutingFallbackRuleResponse(rule) };
      });

      versioned.patch("/routing/workloads/:workloadId/fallback-rules/:ruleId", async (request) => {
        const { workloadId, ruleId } = request.params as { workloadId: string; ruleId: string };
        const patch = validateRoutingFallbackRulePatchInput(request.body);
        const rule = await service.updateFallbackRule(
          requireUuidParam(workloadId, "workloadId"),
          requireUuidParam(ruleId, "ruleId"),
          patch,
          auditContext(request),
        );
        return { fallbackRule: toRoutingFallbackRuleResponse(rule) };
      });

      versioned.delete("/routing/workloads/:workloadId/fallback-rules/:ruleId", async (request) => {
        const { workloadId, ruleId } = request.params as { workloadId: string; ruleId: string };
        const rule = await service.setFallbackRuleEnabled(
          requireUuidParam(workloadId, "workloadId"),
          requireUuidParam(ruleId, "ruleId"),
          false,
          auditContext(request),
        );
        return { fallbackRule: toRoutingFallbackRuleResponse(rule) };
      });

      /**
       * Configuration simulation only — see `RoutingService.preview`. Never
       * calls a provider, never touches a credential, never writes a usage
       * ledger entry or a health event.
       */
      versioned.post("/routing/preview", async (request) => {
        const input = validateRoutingPreviewInput(request.body);
        const decision = await service.preview(input);
        return { decision: toRoutingDecisionResponse(decision) };
      });
    },
    { prefix: config.apiPrefix },
  );
}
