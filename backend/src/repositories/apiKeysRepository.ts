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

  async findById(id: string): Promise<InhouseApiKeyRow | null> {
    const result = await this.db.query<InhouseApiKeyRow>("SELECT * FROM inhouse_api_keys WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async setStatus(id: string, status: string): Promise<InhouseApiKeyRow | null> {
    const result = await this.db.query<InhouseApiKeyRow>(
      "UPDATE inhouse_api_keys SET status = $2 WHERE id = $1 RETURNING *",
      [id, status],
    );
    return result.rows[0] ?? null;
  }

  /** Default deny: `true` only if an explicit (key, workload) grant row exists. */
  async isWorkloadAllowed(apiKeyId: string, workloadId: string): Promise<boolean> {
    const result = await this.db.query(
      "SELECT 1 FROM inhouse_api_key_workloads WHERE api_key_id = $1 AND workload_id = $2",
      [apiKeyId, workloadId],
    );
    return result.rows.length > 0;
  }

  async listWorkloadIds(apiKeyId: string): Promise<string[]> {
    const result = await this.db.query<{ workload_id: string }>(
      "SELECT workload_id FROM inhouse_api_key_workloads WHERE api_key_id = $1 ORDER BY workload_id",
      [apiKeyId],
    );
    return result.rows.map((r) => r.workload_id);
  }

  async listWorkloadIdsByKey(): Promise<Map<string, string[]>> {
    const result = await this.db.query<{ api_key_id: string; workload_id: string }>(
      "SELECT api_key_id, workload_id FROM inhouse_api_key_workloads ORDER BY workload_id",
    );
    const map = new Map<string, string[]>();
    for (const row of result.rows) {
      const list = map.get(row.api_key_id) ?? [];
      list.push(row.workload_id);
      map.set(row.api_key_id, list);
    }
    return map;
  }

  /** Replaces the key's full grant set. Callers run this inside a transaction-capable `db` when atomicity with key creation matters. */
  async replaceWorkloads(apiKeyId: string, workloadIds: string[]): Promise<void> {
    await this.db.query("DELETE FROM inhouse_api_key_workloads WHERE api_key_id = $1", [apiKeyId]);
    if (workloadIds.length === 0) return;
    await this.db.query(
      "INSERT INTO inhouse_api_key_workloads (api_key_id, workload_id) SELECT $1, unnest($2::uuid[])",
      [apiKeyId, workloadIds],
    );
  }
}
