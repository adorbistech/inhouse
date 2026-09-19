import { createHash } from "node:crypto";

/**
 * One-way hash for Inhouse-issued API keys. SHA-256 (not bcrypt/scrypt) is
 * appropriate here specifically because the input is a high-entropy,
 * server-generated random token rather than a user-chosen password — there
 * is no brute-force dictionary to slow down, and a deterministic hash lets
 * lookups key off `key_hash` directly. The raw key itself is never
 * persisted anywhere.
 */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}
