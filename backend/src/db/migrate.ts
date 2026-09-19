import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { loadDbConfig } from "./config.js";

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
export const TRACKING_TABLE = "schema_migrations";

export interface MigrationFile {
  name: string;
  path: string;
  checksum: string;
}

export interface AppliedMigration {
  name: string;
  checksum: string;
}

export async function loadMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const sqlFiles = entries.filter((entry) => entry.endsWith(".sql")).sort();

  return Promise.all(
    sqlFiles.map(async (name) => {
      const filePath = path.join(MIGRATIONS_DIR, name);
      const contents = await readFile(filePath, "utf8");
      const checksum = createHash("sha256").update(contents).digest("hex");
      return { name, path: filePath, checksum };
    }),
  );
}

export async function ensureBootstrap(client: Client, schema: string): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await client.query(`SET search_path TO "${schema}", public`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function loadAppliedMigrations(client: Client): Promise<Map<string, AppliedMigration>> {
  const result = await client.query<AppliedMigration>(`SELECT name, checksum FROM ${TRACKING_TABLE} ORDER BY id`);
  return new Map(result.rows.map((row) => [row.name, row]));
}

export function assertNoChecksumDrift(files: MigrationFile[], applied: Map<string, AppliedMigration>): void {
  for (const file of files) {
    const record = applied.get(file.name);
    if (record && record.checksum !== file.checksum) {
      throw new Error(
        `Checksum mismatch for already-applied migration "${file.name}". ` +
          "The migration file changed after it was applied. Migrations are immutable once " +
          "applied — add a new migration instead of editing this one.",
      );
    }
  }
}

export async function runMigrations(client: Client, schema: string): Promise<void> {
  await ensureBootstrap(client, schema);
  const files = await loadMigrationFiles();
  const applied = await loadAppliedMigrations(client);
  assertNoChecksumDrift(files, applied);

  const pending = files.filter((file) => !applied.has(file.name));
  if (pending.length === 0) {
    console.log(`No pending migrations. ${applied.size} already applied.`);
    return;
  }

  for (const file of pending) {
    const sql = await readFile(file.path, "utf8");
    console.log(`Applying ${file.name} ...`);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO ${TRACKING_TABLE} (name, checksum) VALUES ($1, $2)`, [
        file.name,
        file.checksum,
      ]);
      await client.query("COMMIT");
      console.log(`Applied ${file.name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(`Migration "${file.name}" failed. Stopped before applying any later migrations.`);
      throw error;
    }
  }

  console.log(`Applied ${pending.length} migration(s).`);
}

export async function printStatus(client: Client, schema: string): Promise<void> {
  await ensureBootstrap(client, schema);
  const files = await loadMigrationFiles();
  const applied = await loadAppliedMigrations(client);
  assertNoChecksumDrift(files, applied);

  for (const file of files) {
    const record = applied.get(file.name);
    console.log(`[${record ? "applied" : "pending"}] ${file.name}`);
  }

  const pendingCount = files.filter((file) => !applied.has(file.name)).length;
  console.log(`\n${applied.size} applied, ${pendingCount} pending.`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "up";
  const config = loadDbConfig();
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
  });

  await client.connect();
  try {
    if (command === "status") {
      await printStatus(client, config.schema);
    } else if (command === "up") {
      await runMigrations(client, config.schema);
    } else {
      throw new Error(`Unknown migrate command "${command}". Expected "up" or "status".`);
    }
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
