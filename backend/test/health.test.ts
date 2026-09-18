import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/index.js";

function testConfig() {
  return loadConfig({
    INHOUSE_API_ENV: "test",
  } as NodeJS.ProcessEnv);
}

test("GET /health returns a deterministic ok payload", async () => {
  const app = await buildApp(testConfig());
  const res = await app.inject({ method: "GET", url: "/health" });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), ["environment", "platform", "service", "status", "timestamp"]);
  assert.equal(body.status, "ok");
  assert.equal(body.service, "inhouse-api");
  assert.equal(body.platform, "INHOUSE");
  assert.equal(body.environment, "test");
  assert.ok(!Number.isNaN(Date.parse(body.timestamp)));

  await app.close();
});

test("GET /v1/health matches the /health contract", async () => {
  const app = await buildApp(testConfig());
  const res = await app.inject({ method: "GET", url: "/v1/health" });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.service, "inhouse-api");
  assert.equal(body.platform, "INHOUSE");

  await app.close();
});

test("GET /ready and /v1/ready report ready without any external dependency", async () => {
  const app = await buildApp(testConfig());

  for (const url of ["/ready", "/v1/ready"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "ready");
    assert.equal(body.service, "inhouse-api");
  }

  await app.close();
});

test("responses always carry an x-request-id header", async () => {
  const app = await buildApp(testConfig());
  const res = await app.inject({ method: "GET", url: "/health" });

  assert.ok(typeof res.headers["x-request-id"] === "string" && res.headers["x-request-id"].length > 0);

  await app.close();
});

test("an incoming x-request-id is echoed back unchanged", async () => {
  const app = await buildApp(testConfig());
  const res = await app.inject({
    method: "GET",
    url: "/health",
    headers: { "x-request-id": "fixed-test-request-id" },
  });

  assert.equal(res.headers["x-request-id"], "fixed-test-request-id");

  await app.close();
});
