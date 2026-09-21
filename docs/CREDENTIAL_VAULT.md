# Inhouse Credential Vault (Block 08)

This document is the deep-dive on Block 08. `docs/API.md` documents the
HTTP contract; `docs/DATABASE.md` documents the schema change. This
document explains the encryption design, the security boundary, and what
Block 08 deliberately does not do.

## What Block 08 Establishes

A secure, backend-controlled place to store a vendor's actual provider
credential (an API key, bearer token, etc.), so a later block (a provider
adapter or routing execution engine) has something real to read. Block 08
builds the storage and decrypt boundary only — **nothing in this block
calls a provider, tests a credential, executes a request, or implements
Inhouse API authentication.**

## Two Secret Storage Modes

A `vendor_credentials` row uses **exactly one** of two modes, enforced by
a database `CHECK` constraint (migration `0011`), not just application
code:

1. **`secret_ref`** (Block 05/06, unchanged) — a caller-supplied external
   reference (e.g. a path into an external vault or secret manager).
   Never a secret itself; safe to display and log as-is.
2. **INHOUSE-managed encrypted material** (Block 08) — the actual
   provider secret, encrypted at rest by this application before it ever
   reaches the database.

Sending both `secret` and `secretRef` on a create/rotate, or neither, is
rejected with `400 VALIDATION_ERROR` before anything is written.

### `secret_ref` is a trust boundary, not an enforced one

`secret_ref`'s non-secret status is a design intent traced and confirmed
across every code path that touches it (Block 08 security audit): it is
never decrypted, never sent anywhere, never used as an authorization
credential — no provider-execution code exists in this codebase at all
yet — and never copied into audit metadata *values* (only field *names*
like `"secretRef"` appear there, e.g. in `fields: Object.keys(patch)`).
It is returned as-is in every credential response and rendered as plain
text in the frontend, exactly as it has been since Block 06 — correct
*given* it only ever holds a reference.

**What is not true:** there is no format validation forcing `secretRef`
to look like a reference (e.g. a URL) rather than an actual secret — it
accepts any non-empty string up to 500 characters, the same as Block 06.
Nothing technical stops an operator from pasting a raw provider API key
into `secretRef` instead of using the managed-secret mode. This is a
pre-existing Block 05/06 characteristic, not something Block 08
introduced or worsened — enforcing a reference-shaped format would be a
Block 06 concern to revisit deliberately, not a Block 08 fix, since
Block 08's job was to build the vault `secret_ref` was always meant to
eventually sit beside, not to retroactively police it. The Inhouse
Vault mode is unambiguously safer whenever the actual secret exists
inside this system's control — the frontend now defaults to it.

## Encryption Design

- **Algorithm:** AES-256-GCM (authenticated encryption) — a symmetric
  cipher with a built-in integrity check, not a bare cipher a caller
  would have to add authentication to separately.
- **Nonce:** a fresh, cryptographically random 12-byte IV on every single
  encryption call (`node:crypto`'s `randomBytes`) — never reused, never
  derived from anything predictable. Two encryptions of the same
  plaintext produce different ciphertext.
- **Tamper evidence:** GCM's authentication tag is verified on every
  decrypt. A flipped ciphertext byte, a flipped tag byte, or the wrong
  key all fail loudly (`CredentialVaultError`) rather than returning
  corrupted plaintext silently.
- **Stored per credential:** `secret_ciphertext`, `secret_iv`,
  `secret_auth_tag`, `secret_encryption_version` (for future algorithm
  migration), `secret_fingerprint` (SHA-256 of the plaintext — internal
  only, see "Fingerprint" below), `secret_masked` (safe to display).
- **Implementation:** `backend/src/lib/credentialVault.ts`
  (`CredentialVaultService`), covered by
  `backend/test/credentialVault.test.ts` (round-trip, wrong key, tampered
  ciphertext, tampered auth tag, unsupported version, missing/malformed
  key, empty-secret rejection, fresh-nonce behavior, fingerprint/masking).

## Master Key

- **Source:** `INHOUSE_CREDENTIAL_ENCRYPTION_KEY` — a 64-character hex
  string (32 bytes), loaded by `backend/src/config/credentialVault.ts`.
- **No default, ever.** The process fails fast at startup if it's missing
  or the wrong length/format — the same fail-fast pattern as
  `INHOUSE_DB_PASSWORD` (see `docs/DATABASE.md`). `buildApp()` itself
  refuses to construct if a database pool is provided without a
  `CredentialVaultService` (see `src/app.ts`), so this can't be
  accidentally skipped.
- **Never persisted.** The key lives only in process memory for the
  running instance's lifetime — never written to the database, never
  logged, never returned by any endpoint (including `/health`, `/ready`,
  and every error response).
- **Generate one with:** `openssl rand -hex 32`. `.env.example` documents
  the variable with no value — never commit a real key.
- **Rotating the master key** (as opposed to rotating an individual
  credential's *secret*, which the API supports directly) is an
  operational procedure this block does not automate: every existing
  INHOUSE-managed secret was encrypted under the old key and becomes
  undecryptable the moment the key changes. Rotating the master key
  safely means decrypting every managed secret under the old key and
  re-encrypting under the new one before removing the old key from the
  environment — a migration script for a later block, not implemented
  here.

## Secret Access Boundary

Three distinct types make the boundary obvious in code, not just in
documentation:

- **Safe DTO** (`toCredentialResponse` in `routes/vendors.ts`) — what
  every HTTP response returns. Built from an explicit field whitelist
  that can never accidentally grow to include ciphertext.
- **Stored row** (`VendorCredentialRow`, `repositories/types.ts`) —
  includes the encrypted columns. Used by repositories and the service
  layer; never returned directly from a route.
- **Decrypted secret** (`services/credentialSecretAccess.ts`,
  `getDecryptedCredentialSecret`) — the one function in this codebase
  allowed to return a raw provider secret. It is not imported by
  anything under `routes/`. Access is an intentionally narrow, explicit
  allowlist of trusted server-side services: `services/executionService.ts`
  (request execution, Block 12) and `services/providerVerificationService.ts`
  (admin-triggered bounded health verification, Block 14A). The allowlist is
  enforced by a guard test in `test/db/controlPlaneAuth.test.ts` that fails if
  any other source file references the function — adding a caller is a
  deliberate, reviewed change to that test, never a quiet import. Block 08
  itself calls it from nowhere. There is no HTTP endpoint that decrypts or
  returns a secret, by design.

**Safe default: a disabled credential is never decrypted.** This
function checks `status === "enabled"` before touching the vault and
refuses otherwise. An operator disables a credential specifically to
stop it being used; this is the one place in the codebase that has to
actually honor that, since it's the only path capable of producing the
raw secret at all. See
`test/db/credentialVault.test.ts`'s "a disabled credential's secret
cannot be decrypted" test.

## Fingerprint vs. Masked Value

Both are derived from the plaintext at encryption time, but they serve
different purposes and have different exposure:

- **`secret_masked`** (e.g. `****...ab12`) — safe to return over the API
  and display in the frontend. Reveals only the last few characters,
  matching industry convention (Stripe, GitHub, AWS all do the same).
- **`secret_fingerprint`** (SHA-256 of the plaintext) — **internal only,
  never serialized to an API response.** It exists to let future code
  detect whether a secret changed without decrypting it. It is not
  returned to the frontend deliberately: exposing it would let someone
  who can guess a candidate secret confirm the guess offline by hashing
  it and comparing — the same reasoning `lib/apiKeyHash.ts` documents for
  why Inhouse-issued API keys are hashed instead of encrypted, applied in
  reverse here (a fingerprint is safe to *compute*, not necessarily safe
  to *expose*).

## Audit Behavior

Credential lifecycle actions are recorded to `audit_events`:
`vendor_credential.created`, `vendor_credential.updated`,
`vendor_credential.rotated` (specifically when a `secret`/`secretRef`
changes), `vendor_credential.enabled`/`vendor_credential.disabled`
(status changes), `vendor_credential.deleted`. Audit metadata is always a
small, fixed set of non-secret fields (vendor id, changed field names) —
never a secret value, ciphertext, or the encryption key. See
`test/db/credentialVault.test.ts`'s audit assertions.

## Frontend Secret Handling

`frontend/src/pages/Vendors.tsx`'s credential UI:

- Lets an operator choose "Inhouse Vault" (enter the raw secret — a
  `type="password"` field) or "External Reference" (enter a `secretRef`),
  mutually exclusive, mirroring the backend's two modes.
- Never renders a stored secret in full — only `maskedSecret` (already
  masked by the backend) or the external `secretRef` (never a secret).
- Clears the raw-secret input from component state immediately after a
  successful save/rotate; the value never reaches `localStorage`,
  `sessionStorage`, the URL, or a console log.
- TLS + this backend encryption boundary is the intended security
  boundary — there is no browser-side encryption layer, and none is
  needed given the above.

## Operational Key-Management Expectations

This block assumes the operator:

- Generates `INHOUSE_CREDENTIAL_ENCRYPTION_KEY` once per environment
  (`openssl rand -hex 32`) and stores it the same way `INHOUSE_DB_PASSWORD`
  is stored today (outside version control, in the deployment's own
  secret storage).
- Understands that losing the key makes every INHOUSE-managed credential
  permanently undecryptable — there is no recovery mechanism in this
  block. `secretRef`-mode credentials are unaffected (they never depended
  on this key).
- Treats a master-key rotation as a deliberate operational procedure
  (decrypt-under-old, re-encrypt-under-new for every managed secret)
  rather than a simple environment-variable swap — see "Master Key" above.

## What Block 08 Does *Not* Implement

- Provider integrations, provider SDKs, or any call to a real provider —
  still not implemented.
- Credential "test connection" — still not implemented (needs a
  provider adapter).
- Model execution or a routing engine that would consume a decrypted
  credential — still not implemented.
- Inhouse API authentication (`inhouse_api_keys`) — unrelated to this
  block; this vault protects *provider* secrets, not access to the
  Inhouse API itself.
- Master-key rotation automation — a deliberate operational procedure,
  not automated here (see "Master Key" above).
- Hardware security modules, external KMS integration, or any encryption
  scheme beyond application-layer AES-256-GCM with an environment-sourced
  key — a reasonable foundation for this stage, not a claim that it's
  sufficient for every future compliance requirement.
