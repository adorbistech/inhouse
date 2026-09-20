import { expectRow, type Queryable } from "../db/client.js";
import type { NewUsageLedgerEntry, UsageLedgerRow } from "./types.js";

export class UsageLedgerRepository {
  constructor(private readonly db: Queryable) {}

  async create(entry: NewUsageLedgerEntry): Promise<UsageLedgerRow> {
    const result = await this.db.query<UsageLedgerRow>(
      `INSERT INTO usage_ledger (
        execution_id, request_id, inhouse_api_key_id, vendor_id, vendor_account_id, model_id, workload_id,
        primary_tier_id, fallback_tier_id, is_fallback, attempt_count, status, input_tokens,
        output_tokens, total_tokens, latency_ms, error_category, provider_request_id, provider_cost,
        inhouse_cost, currency
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *`,
      [
        entry.execution_id,
        entry.request_id,
        entry.inhouse_api_key_id,
        entry.vendor_id,
        entry.vendor_account_id,
        entry.model_id,
        entry.workload_id,
        entry.primary_tier_id,
        entry.fallback_tier_id,
        entry.is_fallback,
        entry.attempt_count,
        entry.status,
        entry.input_tokens,
        entry.output_tokens,
        entry.total_tokens,
        entry.latency_ms,
        entry.error_category,
        entry.provider_request_id,
        entry.provider_cost,
        entry.inhouse_cost,
        entry.currency,
      ],
    );
    return expectRow(result.rows);
  }

  async findById(id: string): Promise<UsageLedgerRow | null> {
    const result = await this.db.query<UsageLedgerRow>("SELECT * FROM usage_ledger WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async findByExecutionId(executionId: string): Promise<UsageLedgerRow | null> {
    const result = await this.db.query<UsageLedgerRow>("SELECT * FROM usage_ledger WHERE execution_id = $1", [
      executionId,
    ]);
    return result.rows[0] ?? null;
  }

  async listRecent(limit = 100): Promise<UsageLedgerRow[]> {
    const result = await this.db.query<UsageLedgerRow>(
      "SELECT * FROM usage_ledger ORDER BY created_at DESC LIMIT $1",
      [limit],
    );
    return result.rows;
  }
}
