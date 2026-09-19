/**
 * Loads the Inhouse credential-vault master key from the environment.
 * Mirrors `db/config.ts`'s fail-fast pattern: no default, missing value is
 * a startup error. Format validation (64 hex chars = 32 bytes) happens in
 * `CredentialVaultService`'s constructor — kept separate so "missing" and
 * "malformed" produce distinguishable error messages.
 */
export function loadCredentialVaultKey(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.INHOUSE_CREDENTIAL_ENCRYPTION_KEY;
  if (!value || value.trim().length === 0) {
    throw new Error('Missing required environment variable "INHOUSE_CREDENTIAL_ENCRYPTION_KEY".');
  }
  return value;
}
