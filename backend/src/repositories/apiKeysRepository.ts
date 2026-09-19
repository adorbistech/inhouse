import { expectRow, type Queryable } from "../db/client.js";
import { hashApiKey } from "../lib/apiKeyHash.js";
import type { InhouseApiKeyRow } from "./types.js";

export interface NewApiKeyMeta {
  keyId: string;
  name: string;
  permissions: unknown[];
  status: string;
  expiresAt: Date | null;
}

export class ApiKeysRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Persists a new Inhouse API key. Takes the raw key only to hash it here —
   * the raw value itself is never written to a column or returned.
   */
  async createWithRawKey(rawKey: string, meta: NewApiKeyMeta): Promise<InhouseApiKeyRow> {
    const keyHash = hashApiKey(rawKey);
    const result = await this.db.query<InhouseApiKeyRow>(
      `INSERT INTO inhouse_api_keys (key_id, name, key_hash, permissions, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [meta.keyId, meta.name, keyHash, JSON.stringify(meta.permissions), meta.status, meta.expiresAt],
    );
    return expectRow(result.rows);
  }

  async findByRawKey(rawKey: string): Promise<InhouseApiKeyRow | null> {
    const result = await this.db.query<InhouseApiKeyRow>("SELECT * FROM inhouse_api_keys WHERE key_hash = $1", [
      hashApiKey(rawKey),
    ]);
    return result.rows[0] ?? null;
  }

  async findByKeyId(keyId: string): Promise<InhouseApiKeyRow | null> {
    const result = await this.db.query<InhouseApiKeyRow>("SELECT * FROM inhouse_api_keys WHERE key_id = $1", [
      keyId,
    ]);
    return result.rows[0] ?? null;
  }

  async markUsed(id: string): Promise<void> {
    await this.db.query("UPDATE inhouse_api_keys SET last_used_at = now() WHERE id = $1", [id]);
  }

  async list(): Promise<InhouseApiKeyRow[]> {
    const result = await this.db.query<InhouseApiKeyRow>("SELECT * FROM inhouse_api_keys ORDER BY created_at");
    return result.rows;
  }
}
