-- Block 08: Credential / Secret Vault.
--
-- `secret_ref` (Block 05) is untouched in meaning: it remains a
-- caller-supplied, non-secret reference (e.g. a path into an *external*
-- vault or secret manager) — never a plaintext provider secret. This
-- migration adds a second, independent storage mode alongside it: an
-- INHOUSE-managed authenticated-encryption vault that stores the actual
-- provider secret, encrypted at rest (AES-256-GCM, application layer — see
-- backend/src/lib/credentialVault.ts). The encryption key never lives in
-- this database.
--
-- A credential row uses exactly one mode — either an external `secret_ref`
-- or INHOUSE-managed encrypted material — enforced by a CHECK constraint,
-- not just application code. `secret_ref` is made nullable so existing
-- Block 06 rows (which all have it set) remain valid without a backfill;
-- new INHOUSE-managed rows leave it null and populate the encrypted
-- columns instead.
ALTER TABLE vendor_credentials
  ALTER COLUMN secret_ref DROP NOT NULL,
  ADD COLUMN secret_ciphertext BYTEA,
  ADD COLUMN secret_iv BYTEA,
  ADD COLUMN secret_auth_tag BYTEA,
  ADD COLUMN secret_fingerprint TEXT,
  ADD COLUMN secret_masked TEXT,
  ADD COLUMN secret_encryption_version SMALLINT;

-- The four encrypted-material columns are only ever written together (see
-- CredentialVaultService.encrypt()) — partial encrypted state would be
-- undecryptable and is never a valid outcome of any code path.
ALTER TABLE vendor_credentials
  ADD CONSTRAINT vendor_credentials_secret_parts_together_ck CHECK (
    (
      secret_ciphertext IS NULL AND secret_iv IS NULL AND secret_auth_tag IS NULL
      AND secret_fingerprint IS NULL AND secret_masked IS NULL AND secret_encryption_version IS NULL
    ) OR (
      secret_ciphertext IS NOT NULL AND secret_iv IS NOT NULL AND secret_auth_tag IS NOT NULL
      AND secret_fingerprint IS NOT NULL AND secret_masked IS NOT NULL AND secret_encryption_version IS NOT NULL
    )
  );

ALTER TABLE vendor_credentials
  ADD CONSTRAINT vendor_credentials_exactly_one_secret_mode_ck CHECK (
    (secret_ref IS NOT NULL)::int + (secret_ciphertext IS NOT NULL)::int = 1
  );
