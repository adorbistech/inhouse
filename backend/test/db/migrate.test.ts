import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "pg";
import { loadMigrationFiles, runMigrations, TRACKING_TABLE } from "../../src/db/migrate.js";
import { loadTestDbConfig } from "./helpers.js";

async function freshClient(): Promise<{ client: Client; schema: string }> {
  const config = await loadTestDbConfig();
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
  });
  await client.connect();
  return { client, schema: config.schema };
}

test("migration files are ordered and numbered", async () => {
  const files = await loadMigrationFiles();
  assert.ok(files.length > 0);
  const names = files.map((f) => f.name);
  assert.deepEqual(names, [...names].sort());
  for (const name of names) {
    assert.match(name, /^\d{4}_[a-z0-9_]+\.sql$/);
  }
});

test("migrations apply cleanly against a dropped schema", async () => {
  const { client, schema } = await freshClient();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await runMigrations(client, schema);

    const files = await loadMigrationFiles();
    const applied = await client.query<{ name: string }>(`SELECT name FROM ${TRACKING_TABLE} ORDER BY id`);
    assert.deepEqual(
      applied.rows.map((r) => r.name),
      files.map((f) => f.name),
    );
  } finally {
    await client.end();
  }
});

test("re-running migrations is a no-op (repeat-safe)", async () => {
  const { client, schema } = await freshClient();
  try {
    await runMigrations(client, schema); // ensure applied at least once
    const before = await client.query<{ name: string }>(`SELECT name FROM ${TRACKING_TABLE} ORDER BY id`);

    await runMigrations(client, schema); // repeat run must not fail or duplicate

    const after = await client.query<{ name: string }>(`SELECT name FROM ${TRACKING_TABLE} ORDER BY id`);
    assert.deepEqual(after.rows, before.rows);
  } finally {
    await client.end();
  }
});

test("migration tracking table records name and checksum per file", async () => {
  const { client, schema } = await freshClient();
  try {
    await runMigrations(client, schema);
    const rows = await client.query<{ name: string; checksum: string }>(
      `SELECT name, checksum FROM ${TRACKING_TABLE}`,
    );
    assert.ok(rows.rows.length > 0);
    for (const row of rows.rows) {
      assert.match(row.checksum, /^[a-f0-9]{64}$/);
    }
  } finally {
    await client.end();
  }
});

test("migrations create the dedicated Inhouse schema and its tables", async () => {
  const { client, schema } = await freshClient();
  try {
    await runMigrations(client, schema);
    const result = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schema],
    );
    const tables = result.rows.map((r) => r.table_name).sort();
    assert.ok(tables.includes("vendors"));
    assert.ok(tables.includes("inhouse_api_keys"));
    assert.ok(tables.includes("usage_ledger"));
    assert.ok(tables.includes("audit_events"));
    assert.ok(!tables.includes("public") && schema !== "public", "must not land in the public schema");
  } finally {
    await client.end();
  }
});
