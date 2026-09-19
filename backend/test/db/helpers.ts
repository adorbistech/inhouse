import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import type { DbConfig } from "../../src/types/db.js";
import { runMigrations } from "../../src/db/migrate.js";
import type { Queryable } from "../../src/db/client.js";

const STATE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".test-db.json",
);

/**
 * Loads the connection info written by `scripts/testDb.ts start`. Every
 * DB-backed test uses this — never the host's PostgreSQL, never
 * `adorbis-core-test-postgres`, and never anything outside the disposable
 * `inhouse-postgres-test` container.
 */
export async function loadTestDbConfig(): Promise<DbConfig> {
  let raw: string;
  try {
    raw = await readFile(STATE_FILE, "utf8");
  } catch {
    throw new Error(
      'Test database not found. Run "npm run test:db:start" before running tests under test/db/ ' +
        '(or use "npm run test:db" to do both).',
    );
  }
  return JSON.parse(raw) as DbConfig;
}

export async function withMigratedClient<T>(fn: (client: Client, config: DbConfig) => Promise<T>): Promise<T> {
  const config = await loadTestDbConfig();
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
  });
  await client.connect();
  try {
    await runMigrations(client, config.schema);
    return await fn(client, config);
  } finally {
    await client.end();
  }
}

export async function withMigratedPool<T>(fn: (pool: Pool, config: DbConfig) => Promise<T>): Promise<T> {
  const config = await loadTestDbConfig();
  const bootstrapClient = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
  });
  await bootstrapClient.connect();
  await runMigrations(bootstrapClient, config.schema);
  await bootstrapClient.end();

  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    options: `-c search_path=${config.schema},public`,
    max: 5,
  });
  try {
    return await fn(pool, config);
  } finally {
    await pool.end();
  }
}

/** Truncates every Inhouse table between tests so each test starts clean. */
export async function truncateAll(db: Queryable, schema: string): Promise<void> {
  await db.query(`SET search_path TO "${schema}", public`);
  await db.query(`
    TRUNCATE TABLE
      audit_events, usage_ledger, inhouse_api_keys, routing_fallback_rules,
      routing_tiers, model_workloads, workloads, model_capabilities,
      capabilities, models, vendor_credentials, vendor_accounts, vendors
    RESTART IDENTITY CASCADE
  `);
}
