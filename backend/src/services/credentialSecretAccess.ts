import type { Pool } from "pg";
import type { CredentialVaultService } from "../lib/credentialVault.js";
import { VendorCredentialsRepository } from "../repositories/vendorCredentialsRepository.js";

/**
 * The one path in this codebase allowed to return a decrypted provider
 * secret. Deliberately kept out of `vendorService.ts` and never imported
 * by anything under `routes/` — every HTTP response uses the safe
 * credential DTO (see `routes/vendors.ts`'s `toCredentialResponse`), never
 * this. Restricted to an explicit allowlist of trusted server-side
 * services: `executionService.ts` (Block 12, request execution) and
 * `providerVerificationService.ts` (Block 14A, admin-triggered bounded
 * health verification). The allowlist is enforced by the boundary test in
 * test/db/controlPlaneAuth.test.ts — adding a caller means deliberately
 * changing that test, never quietly importing this.
 */
export async function getDecryptedCredentialSecret(
  pool: Pool,
  vault: CredentialVaultService,
  credentialId: string,
): Promise<string> {
  const credential = await new VendorCredentialsRepository(pool).findById(credentialId);
  if (!credential) {
    throw new Error(`Credential "${credentialId}" was not found.`);
  }
  // Safe default: a disabled credential is never decrypted. An operator
  // disables a credential specifically to stop it being used — this
  // boundary is the one place that guarantee has to actually hold, since
  // it's the only path that can ever produce the raw secret.
  if (credential.status !== "enabled") {
    throw new Error(`Credential "${credentialId}" is not enabled (status: "${credential.status}") — refusing to decrypt.`);
  }
  if (
    credential.secret_ciphertext === null ||
    credential.secret_iv === null ||
    credential.secret_auth_tag === null ||
    credential.secret_encryption_version === null
  ) {
    throw new Error(
      `Credential "${credentialId}" has no INHOUSE-managed secret to decrypt (it uses an external secretRef).`,
    );
  }
  return vault.decrypt({
    ciphertext: credential.secret_ciphertext,
    iv: credential.secret_iv,
    authTag: credential.secret_auth_tag,
    version: credential.secret_encryption_version,
  });
}
