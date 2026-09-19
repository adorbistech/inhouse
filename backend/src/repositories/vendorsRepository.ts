import { expectRow, type Queryable } from "../db/client.js";
import type { NewVendor, VendorRow } from "./types.js";

export class VendorsRepository {
  constructor(private readonly db: Queryable) {}

  async create(vendor: NewVendor): Promise<VendorRow> {
    const result = await this.db.query<VendorRow>(
      `INSERT INTO vendors (
        slug, display_name, vendor_type, protocol, base_endpoint, description,
        status, billing_type, default_tier, max_tier, automatic_fallback,
        timeout_ms, retry_max_attempts, retry_backoff_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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

  async list(): Promise<VendorRow[]> {
    const result = await this.db.query<VendorRow>("SELECT * FROM vendors ORDER BY created_at");
    return result.rows;
  }
}
