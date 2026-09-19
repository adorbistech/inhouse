# Services

Business logic orchestration: validation happens before this layer,
routes call into it, and it owns transactions and audit-event recording.
No SQL lives here — every query goes through a typed repository.

- `vendorService.ts` (Block 06, extended in Block 08) — the Vendor
  System: vendors, vendor accounts, vendor credentials, and vendor
  capability/workload assignment. Block 08 added the encrypt-on-write
  path for a credential's `secret` (via `CredentialVaultService`,
  `lib/credentialVault.ts`) alongside the unchanged `secretRef` mode.
- `modelService.ts` (Block 07) — the Model Catalog: models, and model
  capability/workload assignment. Mirrors `vendorService.ts`'s
  architecture, including the existence-check guard for capability/
  workload ids before assignment.
- `credentialSecretAccess.ts` (Block 08) — deliberately **not** like the
  other files here: a single narrow function
  (`getDecryptedCredentialSecret`) that is the only place in this
  codebase allowed to return a decrypted provider secret. Never imported
  by anything under `routes/`; reserved for a later trusted backend
  execution path. See `docs/CREDENTIAL_VAULT.md`.
- `providerHealthService.ts` (Block 09) — provider-account health:
  records observations, maintains the current-snapshot table, serves
  history. Provider-agnostic (no vendor-type branching), makes no
  network calls, and does not write to `audit_events` (health is
  operational telemetry, not an administrative action). See
  `docs/PROVIDER_HEALTH.md`.
- `providerAdapter.ts` (Block 09) — not a service, an interface. Defines
  the `ProviderAdapter`/`ProviderHealthCheckResult` shape a future block
  will implement to perform a real, network-calling health check.
  Nothing in this codebase implements or calls it yet.

Reserved for future Inhouse business logic not yet built: routing,
telemetry, accounting, real provider adapters.
