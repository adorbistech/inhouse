import { randomBytes } from "node:crypto";

/**
 * `ihk_` prefix (Inhouse Key) makes an accidentally-leaked key
 * grep/secret-scanner-recognizable and immediately distinguishable from a
 * provider credential. `keyId` is a separate, non-secret display
 * identifier (safe to show in the UI/audit logs) — never the value used
 * for authentication itself, which is only ever `rawKey`'s hash (see
 * lib/apiKeyHash.ts). `rawKey` is returned to the caller exactly once, at
 * creation time, and is never persisted or logged anywhere.
 */
export function generateApiKey(): { keyId: string; rawKey: string } {
  return {
    keyId: `key_${randomBytes(6).toString("hex")}`,
    rawKey: `ihk_${randomBytes(32).toString("hex")}`,
  };
}
