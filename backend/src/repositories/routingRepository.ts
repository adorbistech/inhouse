import { expectRow, type Queryable } from "../db/client.js";
import type {
  NewRoutingFallbackRule,
  NewRoutingTier,
  RoutingFallbackRulePatch,
  RoutingFallbackRuleRow,
  RoutingTierPatch,
  RoutingTierRow,
} from "./types.js";

/**
 * Whitelisted, compile-time-fixed column names for dynamic UPDATE SET
 * clauses — never derived from request input (see `vendorsRepository.ts`'s
 * identical pattern).
 */
const ROUTING_TIER_PATCH_COLUMNS = [
  "priority",
  "enabled",
  "timeout_override_ms",
  "max_attempts",
] as const satisfies readonly (keyof RoutingTierPatch)[];

const ROUTING_FALLBACK_RULE_PATCH_COLUMNS = [
  "condition_type",
  "condition_config",
  "priority",
  "enabled",
] as const satisfies readonly (keyof RoutingFallbackRulePatch)[];

export class RoutingRepository {
  constructor(private readonly db: Queryable) {}

  async createTier(tier: NewRoutingTier): Promise<RoutingTierRow> {
    const result = await this.db.query<RoutingTierRow>(
      `INSERT INTO routing_tiers (
        workload_id, tier_number, vendor_id, model_id, priority, enabled,
        timeout_override_ms, max_attempts
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        tier.workload_id,
        tier.tier_number,
        tier.vendor_id,
        tier.model_id,
        tier.priority,
        tier.enabled,
        tier.timeout_override_ms,
        tier.max_attempts,
      ],
    );
    return expectRow(result.rows);
  }

  async findTierById(id: string): Promise<RoutingTierRow | null> {
    const result = await this.db.query<RoutingTierRow>("SELECT * FROM routing_tiers WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async listTiersForWorkload(workloadId: string): Promise<RoutingTierRow[]> {
    const result = await this.db.query<RoutingTierRow>(
      "SELECT * FROM routing_tiers WHERE workload_id = $1 ORDER BY tier_number",
      [workloadId],
    );
    return result.rows;
  }

  async updateTier(id: string, patch: RoutingTierPatch): Promise<RoutingTierRow | null> {
    const columns = ROUTING_TIER_PATCH_COLUMNS.filter((column) => patch[column] !== undefined);
    if (columns.length === 0) {
      return this.findTierById(id);
    }
    const setClause = columns.map((column, index) => `${column} = $${index + 2}`).join(", ");
    const values = columns.map((column) => patch[column]);
    const result = await this.db.query<RoutingTierRow>(
      `UPDATE routing_tiers SET ${setClause} WHERE id = $1 RETURNING *`,
      [id, ...values],
    );
    return result.rows[0] ?? null;
  }

  async setTierEnabled(id: string, enabled: boolean): Promise<RoutingTierRow | null> {
    const result = await this.db.query<RoutingTierRow>(
      "UPDATE routing_tiers SET enabled = $2 WHERE id = $1 RETURNING *",
      [id, enabled],
    );
    return result.rows[0] ?? null;
  }

  async createFallbackRule(rule: NewRoutingFallbackRule): Promise<RoutingFallbackRuleRow> {
    const result = await this.db.query<RoutingFallbackRuleRow>(
      `INSERT INTO routing_fallback_rules (
        workload_id, from_tier_id, to_tier_id, condition_type, condition_config, priority, enabled
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        rule.workload_id,
        rule.from_tier_id,
        rule.to_tier_id,
        rule.condition_type,
        rule.condition_config,
        rule.priority,
        rule.enabled,
      ],
    );
    return expectRow(result.rows);
  }

  async listFallbackRulesForWorkload(workloadId: string): Promise<RoutingFallbackRuleRow[]> {
    const result = await this.db.query<RoutingFallbackRuleRow>(
      "SELECT * FROM routing_fallback_rules WHERE workload_id = $1 ORDER BY priority",
      [workloadId],
    );
    return result.rows;
  }

  async findFallbackRuleById(id: string): Promise<RoutingFallbackRuleRow | null> {
    const result = await this.db.query<RoutingFallbackRuleRow>(
      "SELECT * FROM routing_fallback_rules WHERE id = $1",
      [id],
    );
    return result.rows[0] ?? null;
  }

  async updateFallbackRule(id: string, patch: RoutingFallbackRulePatch): Promise<RoutingFallbackRuleRow | null> {
    const columns = ROUTING_FALLBACK_RULE_PATCH_COLUMNS.filter((column) => patch[column] !== undefined);
    if (columns.length === 0) {
      return this.findFallbackRuleById(id);
    }
    const setClause = columns.map((column, index) => `${column} = $${index + 2}`).join(", ");
    const values = columns.map((column) => patch[column]);
    const result = await this.db.query<RoutingFallbackRuleRow>(
      `UPDATE routing_fallback_rules SET ${setClause} WHERE id = $1 RETURNING *`,
      [id, ...values],
    );
    return result.rows[0] ?? null;
  }

  async setFallbackRuleEnabled(id: string, enabled: boolean): Promise<RoutingFallbackRuleRow | null> {
    const result = await this.db.query<RoutingFallbackRuleRow>(
      "UPDATE routing_fallback_rules SET enabled = $2 WHERE id = $1 RETURNING *",
      [id, enabled],
    );
    return result.rows[0] ?? null;
  }
}
