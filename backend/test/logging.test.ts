import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/index.js";

function captureStream() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, chunks };
}

test("authorization and cookie header values are never present in logs", async () => {
  const { stream, chunks } = captureStream();
  const config = loadConfig({
    INHOUSE_API_ENV: "test",
  } as NodeJS.ProcessEnv);
  const app = await buildApp(config, { loggerStream: stream });

  await app.inject({
    method: "GET",
    url: "/health",
    headers: {
      authorization: "Bearer super-secret-value",
      cookie: "session=super-secret-cookie",
    },
  });
  await app.close();

  const output = chunks.join("");
  assert.ok(output.length > 0, "expected the request to produce log output");
  assert.ok(!output.includes("super-secret-value"));
  assert.ok(!output.includes("super-secret-cookie"));
  assert.ok(output.includes("[Redacted]"));
});
