import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "pg";
import { loadTestDbConfig, withMigratedPool } from "./helpers.js";

test("a wrong database password never appears in the connection error", async () => {
  const config = await loadTestDbConfig();
  const wrongPassword = "definitely-the-wrong-password";
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: wrongPassword,
  });

  await assert.rejects(async () => {
    try {
      await client.connect();
    } finally {
      await client.end().catch(() => undefined);
    }
  }, (error: unknown) => {
    assert.ok(!String(error).includes(wrongPassword), "connection error must not leak the attempted password");
    return true;
  });
});

test("vendor_credentials has no plaintext-secret column, only a secret reference", async () => {
  await withMigratedPool(async (pool, config) => {
    const result = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'vendor_credentials'`,
      [config.schema],
    );
    const columns = result.rows.map((r) => r.column_name);
    assert.ok(columns.includes("secret_ref"));
    assert.ok(!columns.some((c) => /plaintext|raw_secret|secret_value/i.test(c)));
  });
});

test("inhouse_api_keys has no raw-key column, only key_hash", async () => {
  await withMigratedPool(async (pool, config) => {
    const result = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'inhouse_api_keys'`,
      [config.schema],
    );
    const columns = result.rows.map((r) => r.column_name);
    assert.ok(columns.includes("key_hash"));
    assert.ok(!columns.some((c) => /raw_key|plaintext/i.test(c)));
  });
});
