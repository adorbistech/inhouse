import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
const MASK_VISIBLE_CHARS = 4;

/** Current on-disk format version — bumped only if the encryption scheme ever changes. */
const ENCRYPTION_VERSION = 1;

export class CredentialVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialVaultError";
  }
}

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  /** SHA-256 of the plaintext — internal only, never serialized to an API response (see docs/CREDENTIAL_VAULT.md). */
  fingerprint: string;
  /** Safe to display: fixed-width, reveals only the last few characters. */
  maskedIdentifier: string;
  version: number;
}

export interface EncryptedSecretRecord {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  version: number;
}

function parseKey(rawKey: string): Buffer {
  const trimmed = rawKey.trim();
  if (!KEY_HEX_PATTERN.test(trimmed)) {
    throw new CredentialVaultError(
      "INHOUSE_CREDENTIAL_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). " +
        "Generate one with: openssl rand -hex 32",
    );
  }
  const key = Buffer.from(trimmed, "hex");
  if (key.length !== KEY_BYTES) {
    throw new CredentialVaultError(`INHOUSE_CREDENTIAL_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes.`);
  }
  return key;
}

function fingerprint(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

function mask(plaintext: string): string {
  if (plaintext.length <= MASK_VISIBLE_CHARS) {
    return "*".repeat(plaintext.length);
  }
  return `${"*".repeat(Math.max(plaintext.length - MASK_VISIBLE_CHARS, 4))}${plaintext.slice(-MASK_VISIBLE_CHARS)}`;
}

/**
 * INHOUSE's own authenticated-encryption boundary for provider credential
 * secrets (Block 08). AES-256-GCM: a fresh random nonce every call (never
 * reused), authentication tag verified on decrypt (tamper-evident — a
 * flipped ciphertext byte or a wrong key both fail loudly rather than
 * silently returning garbage). The master key never lives in this
 * database, source, or logs — it comes from
 * `INHOUSE_CREDENTIAL_ENCRYPTION_KEY` (see config/credentialVault.ts) and
 * is held only in process memory for this instance's lifetime.
 */
export class CredentialVaultService {
  private readonly key: Buffer;

  constructor(rawKey: string) {
    this.key = parseKey(rawKey);
  }

  encrypt(plaintext: string): EncryptedSecret {
    if (typeof plaintext !== "string" || plaintext.length === 0) {
      throw new CredentialVaultError("Cannot encrypt an empty secret.");
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext,
      iv,
      authTag,
      fingerprint: fingerprint(plaintext),
      maskedIdentifier: mask(plaintext),
      version: ENCRYPTION_VERSION,
    };
  }

  decrypt(record: EncryptedSecretRecord): string {
    if (record.version !== ENCRYPTION_VERSION) {
      throw new CredentialVaultError(`Unsupported credential encryption version: ${record.version}.`);
    }
    // Every crypto call is inside this try, deliberately — a malformed
    // IV/auth-tag length (e.g. corrupted storage) throws synchronously
    // from createDecipheriv/setAuthTag, before update/final ever run, and
    // must fail exactly as cleanly as a tampered ciphertext or wrong key.
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, record.iv);
      decipher.setAuthTag(record.authTag);
      return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new CredentialVaultError(
        "Failed to decrypt credential secret: wrong encryption key or corrupted/tampered ciphertext.",
      );
    }
  }
}
