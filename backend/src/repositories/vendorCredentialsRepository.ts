import { expectRow, type Queryable } from "../db/client.js";
import type { NewVendorCredential, VendorCredentialPatch, VendorCredentialRow } from "./types.js";

const CREDENTIAL_PATCH_COLUMNS = [
  "credential_type",
  "secret_ref",
  "secret_ciphertext",
  "secret_iv",
  "secret_auth_tag",
  "secret_fingerprint",
  "secret_masked",
  "secret_encryption_version",
  "status",
] as const satisfies readonly (keyof VendorCredentialPatch)[];

export class VendorCredentialsRepository {
  constructor(private readonly db: Queryable) {}

  async create(credential: NewVendorCredential): Promise<VendorCredentialRow> {
    const result = await this.db.query<VendorCredentialRow>(
      `INSERT INTO vendor_credentials (
         vendor_account_id, credential_type, status,
         secret_ref, secret_ciphertext, secret_iv, secret_auth_tag,
         secret_fingerprint, secret_masked, secret_encryption_version
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        credential.vendor_account_id,
        credential.credential_type,
        credential.status,
        credential.secret_ref,
        credential.secret_ciphertext,
        credential.secret_iv,
        credential.secret_auth_tag,
        credential.secret_fingerprint,
        credential.secret_masked,
        credential.secret_encryption_version,
      ],
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

  /** All credentials across every account belonging to a vendor. */
  async listByVendorId(vendorId: string): Promise<VendorCredentialRow[]> {
    const result = await this.db.query<VendorCredentialRow>(
      `SELECT vc.* FROM vendor_credentials vc
       JOIN vendor_accounts va ON va.id = vc.vendor_account_id
       WHERE va.vendor_id = $1
       ORDER BY vc.created_at`,
      [vendorId],
    );
    return result.rows;
  }

  async update(id: string, patch: VendorCredentialPatch): Promise<VendorCredentialRow | null> {
    const columns = CREDENTIAL_PATCH_COLUMNS.filter((column) => patch[column] !== undefined);
    if (columns.length === 0) {
      return this.findById(id);
    }
    const setClause = columns.map((column, index) => `${column} = $${index + 2}`).join(", ");
    const values = columns.map((column) => patch[column]);
    const result = await this.db.query<VendorCredentialRow>(
      `UPDATE vendor_credentials SET ${setClause} WHERE id = $1 RETURNING *`,
      [id, ...values],
    );
    return result.rows[0] ?? null;
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

  /** No downstream table references a credential by id — a hard delete is safe. */
  async delete(id: string): Promise<boolean> {
    const result = await this.db.query("DELETE FROM vendor_credentials WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
