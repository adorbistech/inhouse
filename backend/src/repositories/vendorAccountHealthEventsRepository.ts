import { expectRow, type Queryable } from "../db/client.js";
import type { NewVendorAccountHealthEvent, VendorAccountHealthEventRow } from "./types.js";

/** Append-only observation history. Never updated or deleted by this block. */
export class VendorAccountHealthEventsRepository {
  constructor(private readonly db: Queryable) {}

  async create(event: NewVendorAccountHealthEvent): Promise<VendorAccountHealthEventRow> {
    const result = await this.db.query<VendorAccountHealthEventRow>(
      `INSERT INTO vendor_account_health_events (
         vendor_account_id, status, latency_ms, error_category, safe_error_code, source, checked_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        event.vendor_account_id,
        event.status,
        event.latency_ms,
        event.error_category,
        event.safe_error_code,
        event.source,
        event.checked_at,
      ],
    );
    return expectRow(result.rows);
  }

  async listRecentByVendorAccountId(vendorAccountId: string, limit: number): Promise<VendorAccountHealthEventRow[]> {
    const result = await this.db.query<VendorAccountHealthEventRow>(
      `SELECT * FROM vendor_account_health_events
       WHERE vendor_account_id = $1
       ORDER BY checked_at DESC
       LIMIT $2`,
      [vendorAccountId, limit],
    );
    return result.rows;
  }
}
