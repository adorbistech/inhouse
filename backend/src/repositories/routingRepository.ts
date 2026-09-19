import { expectRow, type Queryable } from "../db/client.js";
import type { NewRoutingFallbackRule, NewRoutingTier, RoutingFallbackRuleRow, RoutingTierRow } from "./types.js";

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
}
