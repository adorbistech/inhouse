import { expectRow, type Queryable } from "../db/client.js";
import type { NewVendorAccountHealth, VendorAccountHealthRow } from "./types.js";

/**
 * The current health snapshot for a vendor account — one row per account,
 * upserted on every observation by `services/providerHealthService.ts`.
 * No row for an account means "unknown" (never observed) — that state is
 * represented by absence, not a stored value (see `types.ts`).
 */
export class VendorAccountHealthRepository {
  constructor(private readonly db: Queryable) {}

  async findByVendorAccountId(vendorAccountId: string): Promise<VendorAccountHealthRow | null> {
    const result = await this.db.query<VendorAccountHealthRow>(
      "SELECT * FROM vendor_account_health WHERE vendor_account_id = $1",
      [vendorAccountId],
    );
    return result.rows[0] ?? null;
  }

  async upsert(health: NewVendorAccountHealth): Promise<VendorAccountHealthRow> {
    const result = await this.db.query<VendorAccountHealthRow>(
      `INSERT INTO vendor_account_health (
         vendor_account_id, status, consecutive_failures, last_checked_at,
         last_success_at, last_failure_at, last_latency_ms, last_error_category, last_safe_error_code
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (vendor_account_id) DO UPDATE SET
         status = EXCLUDED.status,
         consecutive_failures = EXCLUDED.consecutive_failures,
         last_checked_at = EXCLUDED.last_checked_at,
         last_success_at = EXCLUDED.last_success_at,
         last_failure_at = EXCLUDED.last_failure_at,
         last_latency_ms = EXCLUDED.last_latency_ms,
         last_error_category = EXCLUDED.last_error_category,
         last_safe_error_code = EXCLUDED.last_safe_error_code
       RETURNING *`,
      [
        health.vendor_account_id,
        health.status,
        health.consecutive_failures,
        health.last_checked_at,
        health.last_success_at,
        health.last_failure_at,
        health.last_latency_ms,
        health.last_error_category,
        health.last_safe_error_code,
      ],
    );
    return expectRow(result.rows);
  }
}
