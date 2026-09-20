import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config/index.js";

test("loadConfig applies sane defaults when no env vars are set", () => {
  const config = loadConfig({} as NodeJS.ProcessEnv);

  assert.equal(config.environment, "development");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8092);
  assert.equal(config.logLevel, "info");
  assert.equal(config.apiPrefix, "/v1");
  assert.deepEqual(config.corsAllowedOrigins, []);
});

test("loadConfig rejects an invalid environment", () => {
  assert.throws(() => loadConfig({ INHOUSE_API_ENV: "production-ish" } as NodeJS.ProcessEnv));
});

test("loadConfig rejects a non-numeric port", () => {
  assert.throws(() => loadConfig({ INHOUSE_API_PORT: "not-a-port" } as NodeJS.ProcessEnv));
});

test("loadConfig rejects an out-of-range port", () => {
  assert.throws(() => loadConfig({ INHOUSE_API_PORT: "70000" } as NodeJS.ProcessEnv));
});

test("loadConfig rejects an invalid log level", () => {
  assert.throws(() => loadConfig({ INHOUSE_API_LOG_LEVEL: "verbose" } as NodeJS.ProcessEnv));
});

test("loadConfig rejects a non-positive body limit", () => {
  assert.throws(() => loadConfig({ INHOUSE_API_BODY_LIMIT: "0" } as NodeJS.ProcessEnv));
});

test("loadConfig parses a comma-separated CORS allowlist", () => {
  const config = loadConfig({
    INHOUSE_API_CORS_ORIGINS: "https://a.example.com, https://b.example.com",
  } as NodeJS.ProcessEnv);

  assert.deepEqual(config.corsAllowedOrigins, ["https://a.example.com", "https://b.example.com"]);
});
