import type { VendorCredentialRow } from "../repositories/types.js";

/**
 * The one deterministic definition of "which credential would an account
 * use", shared by `accountReadinessService` (which only reports it) and
 * `executionService` (which decrypts it). Pure: never decrypts, never
 * touches a database or a provider.
 *
 * The first `enabled` credential ordered by `created_at` ascending, with
 * `id` as a stable tie-break. A disabled credential is never a candidate,
 * even if it is older.
 */
export function selectCandidateCredential(credentials: VendorCredentialRow[]): VendorCredentialRow | null {
  const enabled = credentials
    .filter((c) => c.status === "enabled")
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return enabled[0] ?? null;
}

/**
 * Only an INHOUSE-vault-managed secret can be decrypted by verification and
 * execution; an external `secretRef` cannot. This inspects which columns
 * are populated — it never decrypts anything.
 */
export function isUsableCredential(credential: VendorCredentialRow): boolean {
  return (
    credential.secret_ciphertext !== null &&
    credential.secret_iv !== null &&
    credential.secret_auth_tag !== null &&
    credential.secret_encryption_version !== null
  );
}
