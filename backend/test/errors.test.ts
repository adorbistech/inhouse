import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/index.js";

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    INHOUSE_API_ENV: "test",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

function assertStandardErrorShape(body: unknown): asserts body is {
  error: { code: string; message: string; requestId: string };
} {
  assert.ok(body && typeof body === "object" && "error" in body);
  const error = (body as { error: unknown }).error;
  assert.ok(error && typeof error === "object");
  const { code, message, requestId } = error as Record<string, unknown>;
  assert.equal(typeof code, "string");
  assert.equal(typeof message, "string");
  assert.equal(typeof requestId, "string");
  assert.ok((requestId as string).length > 0);
}

test("an unknown route returns a standardized 404 error shape", async () => {
  const app = await buildApp(testConfig());
  const res = await app.inject({ method: "GET", url: "/does-not-exist" });

  assert.equal(res.statusCode, 404);
  const body = res.json();
  assertStandardErrorShape(body);
  assert.equal(body.error.code, "NOT_FOUND");
  assert.ok(body.error.message.includes("/does-not-exist"));

  await app.close();
});

test("no stack trace is ever present in an error response", async () => {
  const app = await buildApp(testConfig());
  const res = await app.inject({ method: "GET", url: "/does-not-exist" });

  assert.ok(!res.payload.toLowerCase().includes("at "));
  assert.ok(!res.payload.includes(".ts:"));
  assert.ok(!res.payload.includes(".js:"));

  await app.close();
});

test("a malformed JSON body is handled safely with the standard error shape", async () => {
  const app = await buildApp(testConfig());
  const res = await app.inject({
    method: "POST",
    url: "/health",
    headers: { "content-type": "application/json" },
    payload: "{not-valid-json",
  });

  assert.ok(res.statusCode >= 400 && res.statusCode < 500);
  assertStandardErrorShape(res.json());

  await app.close();
});

test("a request body over the configured limit is rejected safely", async () => {
  const app = await buildApp(testConfig({ INHOUSE_API_BODY_LIMIT: "16" }));
  const res = await app.inject({
    method: "POST",
    url: "/health",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ padding: "x".repeat(64) }),
  });

  assert.ok(res.statusCode >= 400 && res.statusCode < 500);
  assertStandardErrorShape(res.json());

  await app.close();
});
