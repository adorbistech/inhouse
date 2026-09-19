import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDbConfig } from "../src/db/config.js";

test("loadDbConfig requires a password with no default", () => {
  assert.throws(() => loadDbConfig({} as NodeJS.ProcessEnv), /INHOUSE_DB_PASSWORD/);
});

test("loadDbConfig applies sane non-secret defaults", () => {
  const config = loadDbConfig({ INHOUSE_DB_PASSWORD: "local-only" } as NodeJS.ProcessEnv);
  assert.equal(config.host, "inhouse-postgres");
  assert.equal(config.port, 5432);
  assert.equal(config.database, "inhouse");
  assert.equal(config.user, "inhouse_app");
  assert.equal(config.schema, "inhouse");
  assert.equal(config.poolMin, 2);
  assert.equal(config.poolMax, 10);
  assert.equal(config.ssl, false);
});

test("loadDbConfig rejects a non-numeric port", () => {
  assert.throws(() =>
    loadDbConfig({ INHOUSE_DB_PASSWORD: "x", INHOUSE_DB_PORT: "not-a-port" } as NodeJS.ProcessEnv),
  );
});

test("loadDbConfig rejects an invalid pool size", () => {
  assert.throws(() =>
    loadDbConfig({ INHOUSE_DB_PASSWORD: "x", INHOUSE_DB_POOL_MAX: "0" } as NodeJS.ProcessEnv),
  );
});

test("loadDbConfig rejects a non-boolean SSL value", () => {
  assert.throws(() =>
    loadDbConfig({ INHOUSE_DB_PASSWORD: "x", INHOUSE_DB_SSL: "maybe" } as NodeJS.ProcessEnv),
  );
});

test("loadDbConfig honors explicit overrides", () => {
  const config = loadDbConfig({
    INHOUSE_DB_HOST: "custom-host",
    INHOUSE_DB_PORT: "5555",
    INHOUSE_DB_NAME: "custom_db",
    INHOUSE_DB_USER: "custom_user",
    INHOUSE_DB_PASSWORD: "custom_password",
    INHOUSE_DB_SCHEMA: "custom_schema",
    INHOUSE_DB_POOL_MIN: "1",
    INHOUSE_DB_POOL_MAX: "4",
    INHOUSE_DB_SSL: "true",
  } as NodeJS.ProcessEnv);

  assert.deepEqual(config, {
    host: "custom-host",
    port: 5555,
    database: "custom_db",
    user: "custom_user",
    password: "custom_password",
    schema: "custom_schema",
    poolMin: 1,
    poolMax: 4,
    ssl: true,
  });
});

test("loadDbConfig never invents a default password", () => {
  const source = { INHOUSE_DB_PASSWORD: undefined } as unknown as NodeJS.ProcessEnv;
  assert.throws(() => loadDbConfig(source));
});
