import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { VendorCredentialRow } from "../src/repositories/types.js";
import { isUsableCredential, selectCandidateCredential } from "../src/services/accountCredentialSelection.js";
import { selectCandidateCredential as readinessSelector } from "../src/services/accountReadinessService.js";

function cred(id: string, createdAt: string, overrides: Partial<VendorCredentialRow> = {}): VendorCredentialRow {
  return {
    id,
    vendor_account_id: "acct",
    credential_type: "api_key",
    secret_ref: null,
    status: "enabled",
    secret_ciphertext: Buffer.from("c"),
    secret_iv: Buffer.from("i"),
    secret_auth_tag: Buffer.from("t"),
    secret_fingerprint: "fp",
    secret_masked: "****",
    secret_encryption_version: 1,
    created_at: new Date(createdAt),
    updated_at: new Date(createdAt),
    last_tested_at: null,
    last_successful_at: null,
    ...overrides,
  } as VendorCredentialRow;
}

test("selectCandidateCredential: oldest enabled credential wins; disabled ones are never candidates", () => {
  const older = cred("b", "2026-01-01T00:00:00Z", { status: "disabled" });
  const newer = cred("a", "2026-02-01T00:00:00Z");
  const newest = cred("c", "2026-03-01T00:00:00Z");
  assert.equal(selectCandidateCredential([newest, newer, older])?.id, "a");
  assert.equal(selectCandidateCredential([older]), null);
  assert.equal(selectCandidateCredential([]), null);
});

test("selectCandidateCredential: a created_at tie breaks on id, independent of input order", () => {
  const t = "2026-01-01T00:00:00Z";
  const a = cred("11111111-0000-4000-8000-000000000000", t);
  const b = cred("22222222-0000-4000-8000-000000000000", t);
  assert.equal(selectCandidateCredential([b, a])?.id, a.id);
  assert.equal(selectCandidateCredential([a, b])?.id, a.id);
});

test("selectCandidateCredential does not mutate its input", () => {
  const input = [cred("z", "2026-03-01T00:00:00Z"), cred("y", "2026-01-01T00:00:00Z")];
  selectCandidateCredential(input);
  assert.deepEqual(input.map((c) => c.id), ["z", "y"]);
});

test("isUsableCredential: managed-vault columns are usable, an external secretRef is not", () => {
  assert.equal(isUsableCredential(cred("a", "2026-01-01T00:00:00Z")), true);
  const external = cred("b", "2026-01-01T00:00:00Z", {
    secret_ref: "vault://x",
    secret_ciphertext: null,
    secret_iv: null,
    secret_auth_tag: null,
    secret_fingerprint: null,
    secret_masked: null,
    secret_encryption_version: null,
  });
  assert.equal(isUsableCredential(external), false);
});

test("readiness and execution share one selector implementation", () => {
  assert.equal(readinessSelector, selectCandidateCredential);
});

test("routing boundary: routingService.ts imports no adapter, credential-access, readiness, or execution module", () => {
  const source = readFileSync(new URL("../src/services/routingService.ts", import.meta.url), "utf8");
  const imports = source.split("\n").filter((l) => /^\s*(import|export)\b.*\bfrom\b/.test(l)).join("\n");
  for (const forbidden of ["adapter", "credentialSecretAccess", "accountReadiness", "accountCredentialSelection", "executionService"]) {
    assert.ok(!new RegExp(forbidden, "i").test(imports), `routingService.ts must not import ${forbidden}`);
  }
});
