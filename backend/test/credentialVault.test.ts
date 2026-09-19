import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { loadCredentialVaultKey } from "../src/config/credentialVault.js";
import { CredentialVaultError, CredentialVaultService } from "../src/lib/credentialVault.js";

const TEST_KEY = randomBytes(32).toString("hex");

test("encrypt/decrypt round-trips a secret exactly", () => {
  const vault = new CredentialVaultService(TEST_KEY);
  const plaintext = "sk-super-secret-provider-key-value";
  const encrypted = vault.encrypt(plaintext);
  assert.equal(vault.decrypt(encrypted), plaintext);
});

test("encrypting the same plaintext twice uses a fresh nonce and produces different ciphertext", () => {
  const vault = new CredentialVaultService(TEST_KEY);
  const plaintext = "same-secret-value";
  const first = vault.encrypt(plaintext);
  const second = vault.encrypt(plaintext);
  assert.notEqual(first.iv.toString("hex"), second.iv.toString("hex"));
  assert.notEqual(first.ciphertext.toString("hex"), second.ciphertext.toString("hex"));
  // Both still decrypt to the same plaintext despite differing ciphertext/IV.
  assert.equal(vault.decrypt(first), plaintext);
  assert.equal(vault.decrypt(second), plaintext);
});

test("decrypting with the wrong key fails rather than returning garbage", () => {
  const vault = new CredentialVaultService(TEST_KEY);
  const encrypted = vault.encrypt("a-provider-secret");
  const wrongVault = new CredentialVaultService(randomBytes(32).toString("hex"));
  assert.throws(() => wrongVault.decrypt(encrypted), CredentialVaultError);
});

test("a tampered ciphertext byte fails authentication instead of decrypting silently", () => {
  const vault = new CredentialVaultService(TEST_KEY);
  const encrypted = vault.encrypt("a-provider-secret");
  const tampered = Buffer.from(encrypted.ciphertext);
  tampered[0] = tampered[0] ^ 0xff;
  assert.throws(() => vault.decrypt({ ...encrypted, ciphertext: tampered }), CredentialVaultError);
});

test("a tampered auth tag fails authentication", () => {
  const vault = new CredentialVaultService(TEST_KEY);
  const encrypted = vault.encrypt("a-provider-secret");
  const tampered = Buffer.from(encrypted.authTag);
  tampered[0] = tampered[0] ^ 0xff;
  assert.throws(() => vault.decrypt({ ...encrypted, authTag: tampered }), CredentialVaultError);
});

test("a malformed (wrong-length) auth tag fails cleanly as a CredentialVaultError, not a raw crypto exception", () => {
  const vault = new CredentialVaultService(TEST_KEY);
  const encrypted = vault.encrypt("a-provider-secret");
  assert.throws(() => vault.decrypt({ ...encrypted, authTag: Buffer.from("too-short") }), CredentialVaultError);
});

test("a malformed (wrong-length) IV fails cleanly as a CredentialVaultError, not a raw crypto exception", () => {
  const vault = new CredentialVaultService(TEST_KEY);
  const encrypted = vault.encrypt("a-provider-secret");
  assert.throws(() => vault.decrypt({ ...encrypted, iv: Buffer.from("x") }), CredentialVaultError);
});

test("an unsupported encryption version is rejected before attempting to decrypt", () => {
  const vault = new CredentialVaultService(TEST_KEY);
  const encrypted = vault.encrypt("a-provider-secret");
  assert.throws(() => vault.decrypt({ ...encrypted, version: 999 }), CredentialVaultError);
});

test("constructing the vault with a missing/empty key throws", () => {
  assert.throws(() => new CredentialVaultService(""), CredentialVaultError);
});

test("constructing the vault with a malformed key (wrong length/format) throws", () => {
  assert.throws(() => new CredentialVaultService("not-hex-and-way-too-short"), CredentialVaultError);
  assert.throws(() => new CredentialVaultService(randomBytes(16).toString("hex")), CredentialVaultError);
  assert.throws(() => new CredentialVaultService("g".repeat(64)), CredentialVaultError);
});

test("encrypting an empty secret is rejected", () => {
  const vault = new CredentialVaultService(TEST_KEY);
  assert.throws(() => vault.encrypt(""), CredentialVaultError);
});

test("the encryption key is never present in an encrypted secret's fields or errors", () => {
  const vault = new CredentialVaultService(TEST_KEY);
  const encrypted = vault.encrypt("a-provider-secret");
  const serialized = JSON.stringify({
    ciphertext: encrypted.ciphertext.toString("hex"),
    iv: encrypted.iv.toString("hex"),
    authTag: encrypted.authTag.toString("hex"),
    fingerprint: encrypted.fingerprint,
    maskedIdentifier: encrypted.maskedIdentifier,
  });
  assert.ok(!serialized.includes(TEST_KEY));
  try {
    vault.decrypt({ ...encrypted, ciphertext: Buffer.from("tampered") });
    assert.fail("expected decrypt to throw");
  } catch (error) {
    assert.ok(!String((error as Error).message).includes(TEST_KEY));
  }
});

test("fingerprint is deterministic for the same secret and differs for different secrets", () => {
  const vault = new CredentialVaultService(TEST_KEY);
  const a1 = vault.encrypt("secret-a");
  const a2 = vault.encrypt("secret-a");
  const b = vault.encrypt("secret-b");
  assert.equal(a1.fingerprint, a2.fingerprint);
  assert.notEqual(a1.fingerprint, b.fingerprint);
  assert.notEqual(a1.fingerprint, "secret-a");
});

test("masked identifier reveals only a short trailing fragment, never the full secret", () => {
  const vault = new CredentialVaultService(TEST_KEY);
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234";
  const { maskedIdentifier } = vault.encrypt(secret);
  assert.ok(maskedIdentifier.endsWith(secret.slice(-4)));
  assert.ok(!maskedIdentifier.includes(secret));
  assert.ok(maskedIdentifier.length < secret.length + 1);
  assert.ok(maskedIdentifier.startsWith("*"));
});

test("masking a very short secret never reveals it in full", () => {
  const vault = new CredentialVaultService(TEST_KEY);
  const { maskedIdentifier } = vault.encrypt("ab");
  assert.equal(maskedIdentifier, "**");
});

test("loadCredentialVaultKey throws when the environment variable is missing", () => {
  assert.throws(() => loadCredentialVaultKey({} as NodeJS.ProcessEnv));
});

test("loadCredentialVaultKey throws when the environment variable is blank", () => {
  assert.throws(() => loadCredentialVaultKey({ INHOUSE_CREDENTIAL_ENCRYPTION_KEY: "   " } as NodeJS.ProcessEnv));
});

test("loadCredentialVaultKey never invents a default key", () => {
  assert.throws(() => loadCredentialVaultKey({ INHOUSE_API_ENV: "test" } as NodeJS.ProcessEnv));
});

test("loadCredentialVaultKey returns the raw value for format validation to happen in the vault constructor", () => {
  const key = loadCredentialVaultKey({ INHOUSE_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY } as NodeJS.ProcessEnv);
  assert.equal(key, TEST_KEY);
  assert.doesNotThrow(() => new CredentialVaultService(key));
});
