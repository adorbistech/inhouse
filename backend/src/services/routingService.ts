import type { Pool } from "pg";
import { withTransaction, type Queryable } from "../db/client.js";
import { ConflictError, NotFoundError, ValidationError } from "../lib/httpErrors.js";
import { AuditEventsRepository } from "../repositories/auditEventsRepository.js";
import { CapabilitiesRepository } from "../repositories/capabilitiesRepository.js";
import { ModelsRepository } from "../repositories/modelsRepository.js";
import { RoutingRepository } from "../repositories/routingRepository.js";
import type {
  ModelRow,
  RoutingFallbackRulePatch,
  RoutingFallbackRuleRow,
  RoutingTierPatch,
  RoutingTierRow,
  VendorAccountRow,
  VendorRow,
  WorkloadRow,
} from "../repositories/types.js";
import { VendorAccountHealthRepository } from "../repositories/vendorAccountHealthRepository.js";
import { VendorAccountsRepository } from "../repositories/vendorAccountsRepository.js";
import { VendorsRepository } from "../repositories/vendorsRepository.js";
import { WorkloadsRepository } from "../repositories/workloadsRepository.js";
import type { AuditContext } from "./vendorService.js";
import type {
  CreateRoutingFallbackRuleInput,
  CreateRoutingTierInput,
  RoutingPreviewInput,
} from "../validation/routing.js";

interface PgError {
  code?: string;
  constraint?: string;
}

function isUniqueViolation(error: unknown): error is PgError {
  return typeof error === "object" && error !== null && (error as PgError).code === "23505";
}

/** Never `"unknown"` on the wire outside of the aggregate below — see `aggregateAccountHealth`. */
export type AggregatedHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface RoutingAccountCandidate {
  id: string;
  slug: string;
  displayName: string;
  status: string;
  health: AggregatedHealth;
}

export interface RoutingFallbackRuleSummary {
  id: string;
  fromTierId: string;
  toTierId: string;
  conditionType: string;
  conditionConfig: Record<string, unknown>;
  priority: number;
  enabled: boolean;
}

export interface RoutingCandidate {
  tierId: string;
  tierNumber: number;
  priority: number;
  tierEnabled: boolean;
  vendor: { id: string; slug: string; displayName: string; status: string } | null;
  model: { id: string; inhouseAlias: string; displayName: string; status: string } | null;
  health: AggregatedHealth;
  accounts: RoutingAccountCandidate[];
  retryPolicy: {
    timeoutMs: number | null;
    maxAttempts: number | null;
    retryOnTimeout: boolean;
    retryOnRateLimit: boolean;
    retryOn5xx: boolean;
    retryOnAuthFailure: boolean;
    retryOnInvalidResponse: boolean;
  } | null;
  outgoingFallbackRules: RoutingFallbackRuleSummary[];
  eligible: boolean;
  reasons: string[];
}

export type RoutingDecisionOutcome = "selected" | "no_eligible_candidate" | "no_tiers_configured";

export interface RoutingDecision {
  workload: { id: string; slug: string; displayName: string; status: string };
  requested: { modelId: string | null; capabilityIds: string[] };
  candidates: RoutingCandidate[];
  selectedCandidate: RoutingCandidate | null;
  outcome: RoutingDecisionOutcome;
  fallbackRules: RoutingFallbackRuleSummary[];
  generatedAt: Date;
}

function toFallbackRuleSummary(rule: RoutingFallbackRuleRow): RoutingFallbackRuleSummary {
  return {
    id: rule.id,
    fromTierId: rule.from_tier_id,
    toTierId: rule.to_tier_id,
    conditionType: rule.condition_type,
    conditionConfig: rule.condition_config,
    priority: rule.priority,
    enabled: rule.enabled,
  };
}

/**
 * A vendor's health is observed per-account (Block 09), but a routing
 * tier references a vendor, not one specific account (see
 * docs/ROUTING_POLICY.md, "Health Interpretation"). This aggregates the
 * vendor's account observations into one signal for eligibility:
 * `"healthy"` if any account is healthy, else `"degraded"` if any account
 * is degraded, else `"unhealthy"` only if every account has been observed
 * and every one is unhealthy, else `"unknown"` — which covers both "no
 * accounts exist yet" and "accounts exist but have never been checked".
 * `"unknown"` is never silently treated as `"healthy"`.
 */
function aggregateAccountHealth(accounts: RoutingAccountCandidate[]): AggregatedHealth {
  if (accounts.length === 0) return "unknown";
  if (accounts.some((a) => a.health === "healthy")) return "healthy";
  if (accounts.some((a) => a.health === "degraded")) return "degraded";
  if (accounts.every((a) => a.health === "unhealthy")) return "unhealthy";
  return "unknown";
}

/**
 * Orchestrates Block 11's routing *policy* layer over the Block 05/06
 * routing schema (`routing_tiers`/`routing_fallback_rules`, unchanged) and
 * the Block 06/07/09 reference data it reads (vendors, models, workloads,
 * capabilities, vendor account health). See docs/ROUTING_POLICY.md for
 * the full design.
 *
 * Strict boundary, enforced by construction: this service never imports
 * `ProviderAdapter`/`AdapterRegistry`, `credentialSecretAccess.ts`, or the
 * usage ledger/health-event repositories' write paths. It reads
 * configuration and observed health, computes eligibility and a
 * deterministic candidate order, and returns an explanation — it never
 * calls a provider, decrypts a credential, or persists anything execution-
 * shaped.
 */
export class RoutingService {
  private readonly routing: RoutingRepository;
  private readonly workloads: WorkloadsRepository;
  private readonly vendors: VendorsRepository;
  private readonly models: ModelsRepository;
  private readonly capabilities: CapabilitiesRepository;
  private readonly vendorAccounts: VendorAccountsRepository;
  private readonly vendorAccountHealth: VendorAccountHealthRepository;

  constructor(private readonly pool: Pool) {
    this.routing = new RoutingRepository(pool);
    this.workloads = new WorkloadsRepository(pool);
    this.vendors = new VendorsRepository(pool);
    this.models = new ModelsRepository(pool);
    this.capabilities = new CapabilitiesRepository(pool);
    this.vendorAccounts = new VendorAccountsRepository(pool);
    this.vendorAccountHealth = new VendorAccountHealthRepository(pool);
  }

  private async recordAudit(
    db: Queryable,
    ctx: AuditContext,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await new AuditEventsRepository(db).create({
      actor_id: ctx.actorId,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      metadata,
      request_id: ctx.requestId,
    });
  }

  private async getWorkloadOrThrow(workloadId: string): Promise<WorkloadRow> {
    const workload = await this.workloads.findById(workloadId);
    if (!workload) {
      throw new NotFoundError(`Workload "${workloadId}" was not found.`);
    }
    return workload;
  }

  private async getTierOrThrow(workloadId: string, tierId: string): Promise<RoutingTierRow> {
    const tier = await this.routing.findTierById(tierId);
    if (!tier || tier.workload_id !== workloadId) {
      throw new NotFoundError(`Routing tier "${tierId}" was not found for workload "${workloadId}".`);
    }
    return tier;
  }

  private async getFallbackRuleOrThrow(workloadId: string, ruleId: string): Promise<RoutingFallbackRuleRow> {
    const rule = await this.routing.findFallbackRuleById(ruleId);
    if (!rule || rule.workload_id !== workloadId) {
      throw new NotFoundError(`Fallback rule "${ruleId}" was not found for workload "${workloadId}".`);
    }
    return rule;
  }

  // --- Reads ---

  async getWorkloadRoutingConfig(
    workloadId: string,
  ): Promise<{ workload: WorkloadRow; tiers: RoutingTierRow[]; fallbackRules: RoutingFallbackRuleRow[] }> {
    const workload = await this.getWorkloadOrThrow(workloadId);
    const [tiers, fallbackRules] = await Promise.all([
      this.routing.listTiersForWorkload(workloadId),
      this.routing.listFallbackRulesForWorkload(workloadId),
    ]);
    return { workload, tiers, fallbackRules };
  }

  async listTiers(workloadId: string): Promise<RoutingTierRow[]> {
    await this.getWorkloadOrThrow(workloadId);
    return this.routing.listTiersForWorkload(workloadId);
  }

  async listFallbackRules(workloadId: string): Promise<RoutingFallbackRuleRow[]> {
    await this.getWorkloadOrThrow(workloadId);
    return this.routing.listFallbackRulesForWorkload(workloadId);
  }

  // --- Tier CRUD ---

  /**
   * A tier's vendor/model must already be assigned to the tier's workload
   * (`vendor_workloads`/`model_workloads`, Block 06/05) — routing
   * configuration never silently widens what a vendor/model is allowed to
   * serve. This mirrors `VendorService`/`ModelService`'s existence guards.
   */
  async createTier(workloadId: string, input: CreateRoutingTierInput, ctx: AuditContext): Promise<RoutingTierRow> {
    await this.getWorkloadOrThrow(workloadId);

    const vendor = await this.vendors.findById(input.vendorId);
    if (!vendor) {
      throw new ValidationError(`Unknown vendor id: ${input.vendorId}`);
    }
    const model = await this.models.findById(input.modelId);
    if (!model) {
      throw new ValidationError(`Unknown model id: ${input.modelId}`);
    }
    if (model.vendor_id !== vendor.id) {
      throw new ValidationError(`Model "${input.modelId}" does not belong to vendor "${input.vendorId}".`);
    }

    const vendorWorkloads = await this.workloads.listForVendor(vendor.id);
    if (!vendorWorkloads.some((w) => w.id === workloadId)) {
      throw new ValidationError(`Vendor "${input.vendorId}" is not assigned to workload "${workloadId}".`);
    }
    const modelWorkloads = await this.workloads.listForModel(model.id);
    if (!modelWorkloads.some((w) => w.id === workloadId)) {
      throw new ValidationError(`Model "${input.modelId}" is not assigned to workload "${workloadId}".`);
    }

    try {
      return await withTransaction(this.pool, async (client) => {
        const tier = await new RoutingRepository(client).createTier({
          workload_id: workloadId,
          tier_number: input.tierNumber,
          vendor_id: input.vendorId,
          model_id: input.modelId,
          priority: input.priority,
          enabled: input.enabled,
          timeout_override_ms: input.timeoutOverrideMs,
          max_attempts: input.maxAttempts,
        });
        await this.recordAudit(client, ctx, "routing_tier.created", "routing_tier", tier.id, {
          workloadId,
          vendorId: input.vendorId,
          modelId: input.modelId,
          tierNumber: input.tierNumber,
        });
        return tier;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          `A routing tier already exists for workload "${workloadId}" at tier number ${input.tierNumber} for this vendor/model.`,
        );
      }
      throw error;
    }
  }

  async updateTier(
    workloadId: string,
    tierId: string,
    patch: RoutingTierPatch,
    ctx: AuditContext,
  ): Promise<RoutingTierRow> {
    await this.getTierOrThrow(workloadId, tierId);
    return withTransaction(this.pool, async (client) => {
      const updated = await new RoutingRepository(client).updateTier(tierId, patch);
      if (!updated) {
        throw new NotFoundError(`Routing tier "${tierId}" was not found.`);
      }
      await this.recordAudit(client, ctx, "routing_tier.updated", "routing_tier", tierId, {
        workloadId,
        fields: Object.keys(patch),
      });
      return updated;
    });
  }

  async setTierEnabled(
    workloadId: string,
    tierId: string,
    enabled: boolean,
    ctx: AuditContext,
  ): Promise<RoutingTierRow> {
    await this.getTierOrThrow(workloadId, tierId);
    return withTransaction(this.pool, async (client) => {
      const updated = await new RoutingRepository(client).setTierEnabled(tierId, enabled);
      if (!updated) {
        throw new NotFoundError(`Routing tier "${tierId}" was not found.`);
      }
      await this.recordAudit(client, ctx, `routing_tier.${enabled ? "enabled" : "disabled"}`, "routing_tier", tierId, {
        workloadId,
      });
      return updated;
    });
  }

  // --- Fallback rule CRUD ---

  /**
   * `fromTierId`/`toTierId` must both already belong to `workloadId` — a
   * fallback rule can never reference a tier from a different workload
   * (`getTierOrThrow` enforces this; a mismatch surfaces as 404, same as
   * "this tier doesn't exist in this workload's scope").
   */
  async createFallbackRule(
    workloadId: string,
    input: CreateRoutingFallbackRuleInput,
    ctx: AuditContext,
  ): Promise<RoutingFallbackRuleRow> {
    await this.getWorkloadOrThrow(workloadId);
    await this.getTierOrThrow(workloadId, input.fromTierId);
    await this.getTierOrThrow(workloadId, input.toTierId);

    return withTransaction(this.pool, async (client) => {
      const rule = await new RoutingRepository(client).createFallbackRule({
        workload_id: workloadId,
        from_tier_id: input.fromTierId,
        to_tier_id: input.toTierId,
        condition_type: input.conditionType,
        condition_config: input.conditionConfig,
        priority: input.priority,
        enabled: input.enabled,
      });
      await this.recordAudit(client, ctx, "routing_fallback_rule.created", "routing_fallback_rule", rule.id, {
        workloadId,
        fromTierId: input.fromTierId,
        toTierId: input.toTierId,
        conditionType: input.conditionType,
      });
      return rule;
    });
  }

  async updateFallbackRule(
    workloadId: string,
    ruleId: string,
    patch: RoutingFallbackRulePatch,
    ctx: AuditContext,
  ): Promise<RoutingFallbackRuleRow> {
    await this.getFallbackRuleOrThrow(workloadId, ruleId);
    return withTransaction(this.pool, async (client) => {
      const updated = await new RoutingRepository(client).updateFallbackRule(ruleId, patch);
      if (!updated) {
        throw new NotFoundError(`Fallback rule "${ruleId}" was not found.`);
      }
      await this.recordAudit(client, ctx, "routing_fallback_rule.updated", "routing_fallback_rule", ruleId, {
        workloadId,
        fields: Object.keys(patch),
      });
      return updated;
    });
  }

  async setFallbackRuleEnabled(
    workloadId: string,
    ruleId: string,
    enabled: boolean,
    ctx: AuditContext,
  ): Promise<RoutingFallbackRuleRow> {
    await this.getFallbackRuleOrThrow(workloadId, ruleId);
    return withTransaction(this.pool, async (client) => {
      const updated = await new RoutingRepository(client).setFallbackRuleEnabled(ruleId, enabled);
      if (!updated) {
        throw new NotFoundError(`Fallback rule "${ruleId}" was not found.`);
      }
      await this.recordAudit(
        client,
        ctx,
        `routing_fallback_rule.${enabled ? "enabled" : "disabled"}`,
        "routing_fallback_rule",
        ruleId,
        { workloadId },
      );
      return updated;
    });
  }

  // --- Preview / dry-run ---

  private async assertCapabilitiesExist(capabilityIds: string[]): Promise<void> {
    if (capabilityIds.length === 0) return;
    const found = await this.capabilities.findByIds(capabilityIds);
    const foundIds = new Set(found.map((c) => c.id));
    const missing = capabilityIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new ValidationError(`Unknown capability id(s): ${missing.join(", ")}`);
    }
  }

  private async buildAccountCandidates(vendorId: string): Promise<RoutingAccountCandidate[]> {
    const accounts = await this.vendorAccounts.listByVendorId(vendorId);
    return Promise.all(
      accounts.map(async (account: VendorAccountRow) => {
        const health = await this.vendorAccountHealth.findByVendorAccountId(account.id);
        return {
          id: account.id,
          slug: account.slug,
          displayName: account.display_name,
          status: account.status,
          health: (health?.status as AggregatedHealth | undefined) ?? "unknown",
        };
      }),
    );
  }

  /**
   * Builds one candidate's eligibility, never mutating anything and never
   * calling a provider — see class-level doc comment. `reasons` accumulate
   * every failed check so a caller sees *every* reason a candidate was
   * excluded, not just the first.
   */
  private async buildCandidate(
    tier: RoutingTierRow,
    workload: WorkloadRow,
    fallbackRules: RoutingFallbackRuleRow[],
    requested: { modelId?: string; capabilityIds?: string[] },
  ): Promise<RoutingCandidate> {
    const reasons: string[] = [];

    if (!tier.enabled) reasons.push("tier_disabled");
    if (workload.status !== "enabled") reasons.push("workload_inactive");

    const vendor: VendorRow | null = await this.vendors.findById(tier.vendor_id);
    const model: ModelRow | null = await this.models.findById(tier.model_id);

    if (!vendor) {
      reasons.push("vendor_not_found");
    } else if (vendor.status !== "enabled") {
      reasons.push("vendor_disabled");
    }
    if (!model) {
      reasons.push("model_not_found");
    } else if (model.status !== "enabled") {
      reasons.push("model_disabled");
    }

    if (vendor) {
      const vendorWorkloads = await this.workloads.listForVendor(vendor.id);
      if (!vendorWorkloads.some((w) => w.id === workload.id)) {
        reasons.push("vendor_workload_mismatch");
      }
    }
    if (model) {
      const modelWorkloads = await this.workloads.listForModel(model.id);
      if (!modelWorkloads.some((w) => w.id === workload.id)) {
        reasons.push("model_workload_mismatch");
      }
    }

    if (requested.modelId && tier.model_id !== requested.modelId) {
      reasons.push("model_not_requested");
    }

    if (vendor && model && requested.capabilityIds && requested.capabilityIds.length > 0) {
      const [vendorCaps, modelCaps] = await Promise.all([
        this.capabilities.listForVendor(vendor.id),
        this.capabilities.listForModel(model.id),
      ]);
      const satisfied = new Set([...vendorCaps.map((c) => c.id), ...modelCaps.map((c) => c.id)]);
      for (const capabilityId of requested.capabilityIds) {
        if (!satisfied.has(capabilityId)) {
          reasons.push(`capability_not_supported:${capabilityId}`);
        }
      }
    }

    const accounts = vendor ? await this.buildAccountCandidates(vendor.id) : [];
    const health = aggregateAccountHealth(accounts);
    if (health === "unhealthy") {
      reasons.push("vendor_unhealthy");
    }

    return {
      tierId: tier.id,
      tierNumber: tier.tier_number,
      priority: tier.priority,
      tierEnabled: tier.enabled,
      vendor: vendor ? { id: vendor.id, slug: vendor.slug, displayName: vendor.display_name, status: vendor.status } : null,
      model: model
        ? { id: model.id, inhouseAlias: model.inhouse_alias, displayName: model.display_name, status: model.status }
        : null,
      health,
      accounts,
      retryPolicy: vendor
        ? {
            timeoutMs: tier.timeout_override_ms ?? vendor.timeout_ms,
            maxAttempts: tier.max_attempts ?? vendor.retry_max_attempts,
            retryOnTimeout: vendor.retry_on_timeout,
            retryOnRateLimit: vendor.retry_on_rate_limit,
            retryOn5xx: vendor.retry_on_5xx,
            retryOnAuthFailure: vendor.retry_on_auth_failure,
            retryOnInvalidResponse: vendor.retry_on_invalid_response,
          }
        : null,
      outgoingFallbackRules: fallbackRules.filter((r) => r.from_tier_id === tier.id).map(toFallbackRuleSummary),
      eligible: reasons.length === 0,
      reasons,
    };
  }

  /**
   * Deterministic candidate ordering (see docs/ROUTING_POLICY.md,
   * "Deterministic Ordering"): ascending `tier_number` first (the tier
   * structure's own explicit ordering), then descending `priority` as a
   * tie-break within the same tier number (higher priority preferred —
   * the same convention `vendors.priority` already uses), and finally
   * ascending tier `id` as the last, purely mechanical tie-break. Never
   * `Math.random()`, wall-clock time, object/array iteration order, or
   * insertion order.
   */
  private sortCandidates(candidates: RoutingCandidate[]): RoutingCandidate[] {
    return [...candidates].sort((a, b) => {
      if (a.tierNumber !== b.tierNumber) return a.tierNumber - b.tierNumber;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.tierId < b.tierId ? -1 : a.tierId > b.tierId ? 1 : 0;
    });
  }

  /**
   * Configuration simulation only — read-only against every dependency it
   * touches. Never calls `ProviderAdapter`, `credentialSecretAccess.ts`,
   * or any usage-ledger/health-event write path. See class-level doc
   * comment and docs/ROUTING_POLICY.md, "Preview / Dry-Run Semantics".
   */
  async preview(input: RoutingPreviewInput): Promise<RoutingDecision> {
    const workload = await this.getWorkloadOrThrow(input.workloadId);

    if (input.modelId) {
      const model = await this.models.findById(input.modelId);
      if (!model) {
        throw new ValidationError(`Unknown model id: ${input.modelId}`);
      }
    }
    await this.assertCapabilitiesExist(input.capabilityIds ?? []);

    const [tiers, fallbackRules] = await Promise.all([
      this.routing.listTiersForWorkload(workload.id),
      this.routing.listFallbackRulesForWorkload(workload.id),
    ]);

    if (tiers.length === 0) {
      return {
        workload: { id: workload.id, slug: workload.slug, displayName: workload.display_name, status: workload.status },
        requested: { modelId: input.modelId ?? null, capabilityIds: input.capabilityIds ?? [] },
        candidates: [],
        selectedCandidate: null,
        outcome: "no_tiers_configured",
        fallbackRules: [],
        generatedAt: new Date(),
      };
    }

    const candidates = this.sortCandidates(
      await Promise.all(
        tiers.map((tier) =>
          this.buildCandidate(tier, workload, fallbackRules, {
            modelId: input.modelId,
            capabilityIds: input.capabilityIds,
          }),
        ),
      ),
    );

    const selectedCandidate = candidates.find((c) => c.eligible) ?? null;

    return {
      workload: { id: workload.id, slug: workload.slug, displayName: workload.display_name, status: workload.status },
      requested: { modelId: input.modelId ?? null, capabilityIds: input.capabilityIds ?? [] },
      candidates,
      selectedCandidate,
      outcome: selectedCandidate ? "selected" : "no_eligible_candidate",
      fallbackRules: fallbackRules.map(toFallbackRuleSummary),
      generatedAt: new Date(),
    };
  }
}
