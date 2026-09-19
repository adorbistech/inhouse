import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import type { FastifyInstance } from "fastify";
import type { DbConfig } from "../../src/types/db.js";
import { runMigrations } from "../../src/db/migrate.js";
import type { Queryable } from "../../src/db/client.js";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { CredentialVaultService } from "../../src/lib/credentialVault.js";

/**
 * A fresh, random, in-memory-only key per test run — never written to
 * disk, never committed, never shared with a real deployment's key. Every
 * `withMigratedApp` call in a given process shares this one instance
 * (encryption keys don't need to differ per test; determinism isn't
 * required since nothing here asserts a fixed ciphertext). Exported so
 * tests that need to decrypt directly (e.g. via
 * `services/credentialSecretAccess.ts`) can construct a
 * `CredentialVaultService` with the same key the test app is using.
 */
export const TEST_VAULT_KEY = randomBytes(32).toString("hex");

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

/**
 * Builds a real Fastify app wired to the disposable test database's pool
 * (migrated first), for exercising Vendor System routes end-to-end via
 * `.inject()`. Mirrors `withMigratedPool` but returns an app instead.
 */
export async function withMigratedApp<T>(
  fn: (app: FastifyInstance, pool: Pool, config: DbConfig) => Promise<T>,
): Promise<T> {
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
  const app = await buildApp(loadConfig({ INHOUSE_API_ENV: "test" } as NodeJS.ProcessEnv), {
    pool,
    credentialVault: new CredentialVaultService(TEST_VAULT_KEY),
  });
  try {
    return await fn(app, pool, config);
  } finally {
    await app.close();
    await pool.end();
  }
}

/** Truncates every Inhouse table between tests so each test starts clean. */
export async function truncateAll(db: Queryable, schema: string): Promise<void> {
  await db.query(`SET search_path TO "${schema}", public`);
  await db.query(`
    TRUNCATE TABLE
      audit_events, usage_ledger, inhouse_api_keys, routing_fallback_rules,
      routing_tiers, vendor_workloads, vendor_capabilities, model_workloads,
      workloads, model_capabilities, capabilities, models, vendor_account_health_events,
      vendor_account_health, vendor_credentials, vendor_accounts, vendors
    RESTART IDENTITY CASCADE
  `);
}
