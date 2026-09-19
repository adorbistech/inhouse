import { expectRow, type Queryable } from "../db/client.js";
import type { NewVendorAccount, VendorAccountRow } from "./types.js";

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
}
