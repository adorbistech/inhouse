import { expectRow, type Queryable } from "../db/client.js";
import type { NewVendor, VendorPatch, VendorRow } from "./types.js";

/**
 * Whitelisted, compile-time-fixed column names for dynamic UPDATE SET
 * clauses. Never derived from request input — only the corresponding
 * *values* come from callers, and those are always bound as parameters.
 */
const VENDOR_PATCH_COLUMNS = [
  "slug",
  "display_name",
  "vendor_type",
  "protocol",
  "base_endpoint",
  "description",
  "status",
  "billing_type",
  "default_tier",
  "max_tier",
  "automatic_fallback",
  "timeout_ms",
  "retry_max_attempts",
  "retry_backoff_ms",
  "priority",
  "retry_on_timeout",
  "retry_on_rate_limit",
  "retry_on_5xx",
  "retry_on_auth_failure",
  "retry_on_invalid_response",
] as const satisfies readonly (keyof VendorPatch)[];

export class VendorsRepository {
  constructor(private readonly db: Queryable) {}

  async create(vendor: NewVendor): Promise<VendorRow> {
    const result = await this.db.query<VendorRow>(
      `INSERT INTO vendors (
        slug, display_name, vendor_type, protocol, base_endpoint, description,
        status, billing_type, default_tier, max_tier, automatic_fallback,
        timeout_ms, retry_max_attempts, retry_backoff_ms, priority,
        retry_on_timeout, retry_on_rate_limit, retry_on_5xx,
        retry_on_auth_failure, retry_on_invalid_response
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      RETURNING *`,
      [
        vendor.slug,
        vendor.display_name,
        vendor.vendor_type,
        vendor.protocol,
        vendor.base_endpoint,
        vendor.description,
        vendor.status,
        vendor.billing_type,
        vendor.default_tier,
        vendor.max_tier,
        vendor.automatic_fallback,
        vendor.timeout_ms,
        vendor.retry_max_attempts,
        vendor.retry_backoff_ms,
        vendor.priority,
        vendor.retry_on_timeout,
        vendor.retry_on_rate_limit,
        vendor.retry_on_5xx,
        vendor.retry_on_auth_failure,
        vendor.retry_on_invalid_response,
      ],
    );
    return expectRow(result.rows);
  }

  async findById(id: string): Promise<VendorRow | null> {
    const result = await this.db.query<VendorRow>("SELECT * FROM vendors WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async findBySlug(slug: string): Promise<VendorRow | null> {
    const result = await this.db.query<VendorRow>("SELECT * FROM vendors WHERE slug = $1", [slug]);
    return result.rows[0] ?? null;
  }

  async list(filters: { status?: string } = {}): Promise<VendorRow[]> {
    if (filters.status) {
      const result = await this.db.query<VendorRow>(
        "SELECT * FROM vendors WHERE status = $1 ORDER BY created_at",
        [filters.status],
      );
      return result.rows;
    }
    const result = await this.db.query<VendorRow>("SELECT * FROM vendors ORDER BY created_at");
    return result.rows;
  }

  async update(id: string, patch: VendorPatch): Promise<VendorRow | null> {
    const columns = VENDOR_PATCH_COLUMNS.filter((column) => patch[column] !== undefined);
    if (columns.length === 0) {
      return this.findById(id);
    }
    const setClause = columns.map((column, index) => `${column} = $${index + 2}`).join(", ");
    const values = columns.map((column) => patch[column]);
    const result = await this.db.query<VendorRow>(
      `UPDATE vendors SET ${setClause} WHERE id = $1 RETURNING *`,
      [id, ...values],
    );
    return result.rows[0] ?? null;
  }

  async setStatus(id: string, status: string): Promise<VendorRow | null> {
    const result = await this.db.query<VendorRow>(
      "UPDATE vendors SET status = $2 WHERE id = $1 RETURNING *",
      [id, status],
    );
    return result.rows[0] ?? null;
  }
}
