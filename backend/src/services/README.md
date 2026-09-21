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
  by anything under `routes/`; restricted to the explicitly allowlisted
  trusted services `executionService.ts` and
  `providerVerificationService.ts` (Block 14A), enforced by a guard test.
  See `docs/CREDENTIAL_VAULT.md`.
- `providerHealthService.ts` (Block 09) — provider-account health:
  records observations, maintains the current-snapshot table, serves
  history. Provider-agnostic (no vendor-type branching), makes no
  network calls, and does not write to `audit_events` (health is
  operational telemetry, not an administrative action). See
  `docs/PROVIDER_HEALTH.md`.
- `providerAdapter.ts` (Block 09, extended in Block 10) — not a service,
  an interface. Defines the `ProviderAdapter` shape: Block 09's
  `checkHealth`/`ProviderHealthCheckResult`, plus Block 10's `execute`/
  `NormalizedProviderRequest`/`NormalizedProviderResponse`/
  `NormalizedProviderError`. No route calls either method.
- `adapters/` (Block 10) — the protocol adapter registry
  (`adapterRegistry.ts`: `AdapterRegistry`, `createDefaultAdapterRegistry`),
  the one concrete adapter (`openAiCompatibleAdapter.ts`, protocol
  `"openai-compatible"`), and shared HTTP-status/error-mapping helpers
  (`httpErrorMapping.ts`). Looked up by `vendors.protocol`, never by
  vendor identity — a vendor whose protocol has no registered adapter is
  an expected, normal state. See `docs/PROVIDER_ADAPTERS.md`.

Reserved for future Inhouse business logic not yet built: routing,
telemetry, accounting, wiring an adapter into an actual execution path.
