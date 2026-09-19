import { expectRow, type Queryable } from "../db/client.js";
import type { NewVendorCredential, VendorCredentialRow } from "./types.js";

export class VendorCredentialsRepository {
  constructor(private readonly db: Queryable) {}

  async create(credential: NewVendorCredential): Promise<VendorCredentialRow> {
    const result = await this.db.query<VendorCredentialRow>(
      `INSERT INTO vendor_credentials (vendor_account_id, credential_type, secret_ref, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [credential.vendor_account_id, credential.credential_type, credential.secret_ref, credential.status],
    );
    return expectRow(result.rows);
  }

  async findById(id: string): Promise<VendorCredentialRow | null> {
    const result = await this.db.query<VendorCredentialRow>("SELECT * FROM vendor_credentials WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async listByVendorAccountId(vendorAccountId: string): Promise<VendorCredentialRow[]> {
    const result = await this.db.query<VendorCredentialRow>(
      "SELECT * FROM vendor_credentials WHERE vendor_account_id = $1 ORDER BY created_at",
      [vendorAccountId],
    );
    return result.rows;
  }

  async markTested(id: string, successful: boolean): Promise<VendorCredentialRow | null> {
    const result = await this.db.query<VendorCredentialRow>(
      `UPDATE vendor_credentials
       SET last_tested_at = now(), last_successful_at = CASE WHEN $2 THEN now() ELSE last_successful_at END
       WHERE id = $1
       RETURNING *`,
      [id, successful],
    );
    return result.rows[0] ?? null;
  }
}
