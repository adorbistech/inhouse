import assert from "node:assert/strict";
import { test } from "node:test";
import { hashApiKey } from "../src/lib/apiKeyHash.js";

test("hashApiKey is deterministic for the same input", () => {
  assert.equal(hashApiKey("same-key"), hashApiKey("same-key"));
});

test("hashApiKey produces different hashes for different inputs", () => {
  assert.notEqual(hashApiKey("key-a"), hashApiKey("key-b"));
});

test("hashApiKey never returns the raw input", () => {
  const rawKey = "inhouse_sk_super_secret_value";
  assert.notEqual(hashApiKey(rawKey), rawKey);
  assert.ok(!hashApiKey(rawKey).includes(rawKey));
});

test("hashApiKey returns a fixed-length hex digest", () => {
  assert.match(hashApiKey("anything"), /^[a-f0-9]{64}$/);
});
