import { expectRow, type Queryable } from "../db/client.js";
import type { NewVendorAccount, VendorAccountPatch, VendorAccountRow } from "./types.js";

const ACCOUNT_PATCH_COLUMNS = [
  "slug",
  "display_name",
  "status",
  "external_account_ref",
] as const satisfies readonly (keyof VendorAccountPatch)[];

export class VendorAccountsRepository {
  constructor(private readonly db: Queryable) {}

  async create(account: NewVendorAccount): Promise<VendorAccountRow> {
    const result = await this.db.query<VendorAccountRow>(
      `INSERT INTO vendor_accounts (vendor_id, slug, display_name, status, external_account_ref)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [account.vendor_id, account.slug, account.display_name, account.status, account.external_account_ref],
    );
    return expectRow(result.rows);
  }

  async findById(id: string): Promise<VendorAccountRow | null> {
    const result = await this.db.query<VendorAccountRow>("SELECT * FROM vendor_accounts WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async listByVendorId(vendorId: string): Promise<VendorAccountRow[]> {
    const result = await this.db.query<VendorAccountRow>(
      "SELECT * FROM vendor_accounts WHERE vendor_id = $1 ORDER BY created_at",
      [vendorId],
    );
    return result.rows;
  }

  async update(id: string, patch: VendorAccountPatch): Promise<VendorAccountRow | null> {
    const columns = ACCOUNT_PATCH_COLUMNS.filter((column) => patch[column] !== undefined);
    if (columns.length === 0) {
      return this.findById(id);
    }
    const setClause = columns.map((column, index) => `${column} = $${index + 2}`).join(", ");
    const values = columns.map((column) => patch[column]);
    const result = await this.db.query<VendorAccountRow>(
      `UPDATE vendor_accounts SET ${setClause} WHERE id = $1 RETURNING *`,
      [id, ...values],
    );
    return result.rows[0] ?? null;
  }

  async setStatus(id: string, status: string): Promise<VendorAccountRow | null> {
    const result = await this.db.query<VendorAccountRow>(
      "UPDATE vendor_accounts SET status = $2 WHERE id = $1 RETURNING *",
      [id, status],
    );
    return result.rows[0] ?? null;
  }
}
