# Inhouse API (Block 04 — Foundation, persistence added in Block 05, Vendor System added in Block 06, Model Catalog added in Block 07, Credential Vault added in Block 08, Provider Account Health Foundation added in Block 09, Provider Adapter / Integration Layer added in Block 10, Routing Policy & Deterministic Selection Foundation added in Block 11)

## Status

Authentication, model execution, routing *execution*, telemetry, and
accounting still do not exist. Those remain later blocks. **Block 10
adds the first real provider adapter implementation and a
protocol/adapter registry** — see `docs/PROVIDER_ADAPTERS.md` — but
still exposes no execution endpoint of any kind; the only HTTP-visible
change is the `adapterSupported` field on every vendor response (see
"Vendor System" below). **Block 11 adds a routing *policy* layer** — see
"Routing Policy (Block 11)" below and `docs/ROUTING_POLICY.md` — that can
explain what would be selected for a workload (a dry-run/preview) but
still cannot send an actual request anywhere. `/root/adorbis-api` is a
separate, external service — Inhouse does not call it yet and this
document does not cover it.

Block 05 added a PostgreSQL persistence layer (SQL migrations, a
dedicated Inhouse schema, and typed repositories — see
`docs/DATABASE.md`); at that point no HTTP route used it yet. **Block 06
changed that for one domain: the Vendor System. Block 07 added a second:
the Model Catalog. Block 08 extended the Vendor System's credential
endpoints with a real, INHOUSE-managed secret vault. Block 09 adds
provider-account health observation** — a read-only view of whether a
vendor account's connection is working, with the interface boundary a
future real provider adapter will fill in (see "Vendor Account Health
(Block 09)" below and `docs/PROVIDER_HEALTH.md`). The distinction that
matters going forward:

- **Persistence exists and is now reachable over HTTP** for vendors,
  vendor accounts, vendor credentials (now optionally INHOUSE-vault-managed
  — see below), vendor account health, models, capabilities, workloads,
  and routing tiers/fallback rules (see "Vendor System", "Model
  Catalog", and "Routing Policy (Block 11)" below) — real reads/writes
  through the Block 05/06/07/08/09/11 schema and repositories.
- **`/health` and `/ready` (and their `/v1` equivalents) remain
  database-free by design** — they never depend on the database, so they
  stay reliable as liveness/readiness probes regardless of the database's
  state. This did not change in Block 06, 07, 08, 09, or 11.
- **No route executes a provider call, routing decision, or model
  execution.** The Vendor System and Model Catalog persist *configuration*
  (including routing-adjacent fields like priority and retry conditions,
  and which capabilities/workloads a model supports) — nothing reads that
  configuration to actually route or execute a request yet. Block 08 does
  not decrypt a credential from any route, either — see "Credential Vault
  (Block 08)". **Block 09 makes zero network calls of any kind** — every
  health row in this block is created by a test or an operator calling
  `ProviderHealthService` directly, never by actually checking a
  provider. See `docs/PROVIDER_HEALTH.md`. **Block 10 adds a real,
  network-calling protocol adapter (`OpenAiCompatibleAdapter`) and a
  registry to look one up by protocol — but still no route calls it.**
  Every real network call this block makes happens only inside a test.
  **Block 11 can compute and explain a routing *decision* (a dry-run
  preview) but still cannot act on it** — `POST /v1/routing/preview`
  never calls a provider, decrypts a credential, or writes a usage
  ledger/health-event row. See "Routing Policy (Block 11)" below and
  `docs/ROUTING_POLICY.md`.
  See `docs/PROVIDER_ADAPTERS.md`.
- **Every control-plane route requires the administrative token** (Block
  12E; see "Authentication"). Block 08's vault protects *provider*
  credentials at rest; it is not Inhouse API authentication.

## Service Purpose

`inhouse-api` is the Inhouse product's own backend. It establishes the
API contract (versioning, health/readiness, error shape, request
correlation, logging, baseline security headers/CORS — Block 04) and, as
of Block 06/07, real data-driven control-plane services on top of it (the
Vendor System, Block 06; the Model Catalog, Block 07) built on the Block
05 persistence layer.
The process now opens a Postgres connection pool at startup
(`server.ts`, via `loadDbConfig()`/`createPool()`) — but `/health` and
`/ready` still never touch it (see "Status" above).

## Base URL Concept

Locally / in Docker Compose: `http://127.0.0.1:8092` (port configurable via
`INHOUSE_API_PORT`, see the repository root `.env.example`).

No public domain is wired up yet — `api.inhouse.adorbistech.com` has no DNS
record (see `docs/DEPLOYMENT.md`). This document will be updated once that
exists.

## API Versioning

The versioned contract lives under `/v1`. Root-level, unversioned routes
(`/health`, `/ready`) exist purely as infrastructure probes (e.g. the
Docker `HEALTHCHECK`) and are not part of the versioned API contract.
`/v1/vendors`, `/v1/capabilities`, and `/v1/workloads` exist as of Block
06 (see "Vendor System" below). Future functional endpoints (`/v1/auth`,
`/v1/models`, `/v1/routing`, `/v1/executions`, `/v1/usage`, ...) will be
added under `/v1` in later blocks — none of them exist yet.

## Endpoints (current)

### `GET /health` and `GET /v1/health`

Deterministic liveness check. Never depends on a database, cache, or
external provider.

```json
{
  "status": "ok",
  "service": "inhouse-api",
  "platform": "INHOUSE",
  "environment": "production",
  "timestamp": "2026-09-18T20:30:00.000Z"
}
```

### `GET /ready` and `GET /v1/ready`

Readiness check. Currently identical in spirit to `/health` because there
are no dependencies yet (no DB, no cache, no downstream service). Once a
real dependency is introduced in a later block, this endpoint will begin
checking it and can diverge from `/health`.

```json
{
  "status": "ready",
  "service": "inhouse-api",
  "timestamp": "2026-09-18T20:30:00.000Z"
}
```

## Vendor System (Block 06)

All Vendor System responses are JSON, camelCase, and share the standard
error format below on failure. Every route lives under `/v1` and, like
every control-plane route, requires `Authorization: Bearer
<INHOUSE_ADMIN_TOKEN>` (see "Authentication"). Full schema/persistence detail is in
`docs/DATABASE.md`; this section documents the HTTP contract only.

**Scope:** this block persists vendor *configuration* — it does not call
any real provider, does not test credentials against a provider, and
does not execute routing. A vendor's `status`, capabilities, workloads,
priority, and retry flags are all data an operator sets; nothing reads
them to make a live decision yet.

### Vendors

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/vendors` | Optional `?status=enabled\|disabled\|unavailable` filter |
| `GET` | `/v1/vendors/:id` | Includes nested `accounts`, `capabilities`, `workloads` |
| `POST` | `/v1/vendors` | Optionally accepts `capabilityIds`/`workloadIds` to assign at creation, in the same transaction |
| `PATCH` | `/v1/vendors/:id` | Partial update; at least one field required |
| `DELETE` | `/v1/vendors/:id` | **Soft-disable** (`status` → `disabled`), not a row deletion — see "Deletion Semantics" |
| `PUT` | `/v1/vendors/:id/capabilities` | Replaces the full assigned-capability set (body: `{ "capabilityIds": [...] }`) |
| `PUT` | `/v1/vendors/:id/workloads` | Replaces the full allowed-workload set (body: `{ "workloadIds": [...] }`) |

A vendor status is one of `enabled` / `disabled` / `unavailable` —
enforced by request validation, not a database constraint (see
`docs/DATABASE.md`).

**`adapterSupported` (Block 10):** every vendor response (list, detail,
create, update, status-change) now includes `"adapterSupported": boolean`
— computed at response time from the backend's code-defined protocol/
adapter registry (`AdapterRegistry.has(vendor.protocol)`,
`docs/PROVIDER_ADAPTERS.md`), never stored on the row and never derived
from `status`. `false` means "this vendor is fully configured but no
technical adapter exists for its `protocol` yet" — a normal state, not an
error. As of Block 10, only the `"openai-compatible"` protocol has a
registered adapter; every other `protocol` value (including
`"custom_rest"`, used throughout this document's and the test suite's
sample payloads) reports `adapterSupported: false`.

### Vendor Accounts

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/vendors/:id/accounts` | |
| `POST` | `/v1/vendors/:id/accounts` | |
| `PATCH` | `/v1/vendors/:id/accounts/:accountId` | |
| `DELETE` | `/v1/vendors/:id/accounts/:accountId` | **Soft-disable**, same reasoning as vendor deletion |

A vendor may have multiple accounts; nothing in this API assumes a fixed
`accounts[0]` — every account has its own id, slug, and status.

### Vendor Account Health (Block 09)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/vendors/:id/accounts/:accountId/health` | Current health snapshot |
| `GET` | `/v1/vendors/:id/accounts/:accountId/health/events` | Recent observation history, most recent first. Optional `?limit=` (default 50, max 200) |

Read-only in this block, deliberately: there is no write endpoint.
`status` is one of `healthy` / `degraded` / `unhealthy` / `unknown` —
`unknown` means this account has never been observed (no row exists
yet), not a stored value. Recording an observation
(`ProviderHealthService.recordObservation`, `services/providerHealthService.ts`)
is reserved for a future, trusted provider adapter to call directly;
exposing it over HTTP today would let any caller fabricate an account's
health with no real check behind it. See `docs/PROVIDER_HEALTH.md` for
the full model, including the `ProviderAdapter` interface a later block
will implement.

The health response never includes a credential, a provider response
body, or anything beyond normalized fields (`status`,
`consecutiveFailures`, `lastCheckedAt`, `lastSuccessAt`, `lastFailureAt`,
`lastLatencyMs`, `lastErrorCategory`, `lastSafeErrorCode`).
`lastErrorCategory` is one of a fixed, provider-agnostic set
(`authentication`, `authorization`, `rate_limit`, `timeout`, `network`,
`provider_error`, `configuration`, `unknown`) — never a raw provider
error message.

### Vendor Credentials — Credential Vault (Block 08)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/vendors/:id/credentials` | All credentials across every account belonging to the vendor |
| `POST` | `/v1/vendors/:id/credentials` | Body: `{ vendorAccountId, credentialType, secret }` **or** `{ vendorAccountId, credentialType, secretRef }` — exactly one of `secret`/`secretRef`, see below |
| `PATCH` | `/v1/vendors/:id/credentials/:credentialId` | Partial update; `secret`/`secretRef`/`status`/`credentialType`, at most one of `secret`/`secretRef` — see "Rotation" |
| `DELETE` | `/v1/vendors/:id/credentials/:credentialId` | **Hard delete** — safe, since no other table references a credential by id |

**Two mutually exclusive secret storage modes**, chosen by which field the
caller sends (full detail, threat model, and the encryption design are in
`docs/CREDENTIAL_VAULT.md`):

- **`secret`** — the actual raw provider credential (an API key, bearer
  token, etc.). The backend encrypts it immediately (AES-256-GCM, a fresh
  nonce every time) and stores only the ciphertext — the raw value is
  **never** persisted, logged, or echoed back in any response.
- **`secretRef`** — a caller-supplied external reference (e.g. a path into
  an external vault/secret manager). This is the unchanged Block 06
  behavior: never a secret itself, just a pointer to one that lives
  elsewhere.

Sending both, or neither, is a `400 VALIDATION_ERROR`.

**The response is an explicit safe whitelist** — `id`, `vendorAccountId`,
`credentialType`, `status`, `secretRef` (null when the credential uses a
managed secret), `hasManagedSecret` (boolean), `maskedSecret` (a display
string like `****...ab12`, null when using `secretRef`), `createdAt`,
`updatedAt`, `lastTestedAt`, `lastSuccessfulAt`. **No response, at any
endpoint, ever includes ciphertext, an IV, an auth tag, a fingerprint, or
a raw secret.** There is no `GET .../secret` or `.../decrypt` endpoint —
decryption is reserved for a narrow, route-inaccessible internal function
(`services/credentialSecretAccess.ts`) that a later trusted execution
path (a provider adapter) will call; nothing in Block 08 calls it itself.

**Rotation**: sending `secret` or `secretRef` in a `PATCH` replaces the
credential's stored secret material atomically (within one transaction —
the old material is never left half-replaced) and is recorded as
`vendor_credential.rotated`, distinct from a plain field update. Rotating
can also switch modes (e.g. from a managed secret to an external
`secretRef`, or back).

Registering a credential is intentionally a separate action from creating
a vendor — this API never asks for a provider secret as part of
`POST /v1/vendors`. There is no "test connection against the provider"
endpoint in this block; that requires a real provider adapter (a later
block).

### Reference Data

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/capabilities` | All capability definitions. Empty until an operator creates rows directly (no seed data — see `docs/DATABASE.md`) |
| `GET` | `/v1/workloads` | All workload definitions. Same as above |

There is no `POST`/create endpoint for capabilities or workloads in this
block — assigning them to a vendor (via the vendor endpoints above) is in
scope; defining new capability/workload reference rows is not.

### Deletion Semantics

`DELETE` on a vendor or vendor account never removes the row. Both have
`ON DELETE CASCADE` foreign keys from dependent tables (accounts,
credentials, models, routing configuration for a vendor; credentials for
an account) — a real `DELETE` would silently destroy that configuration.
Instead, `DELETE` sets `status` to `disabled`. Vendor credentials have no
such downstream dependents, so `DELETE` there is a real row deletion.

### Audit Trail

Vendor/account/credential create, update, and status-change operations
are recorded to `audit_events` (`vendor.created`, `vendor.updated`,
`vendor.enabled`, `vendor.disabled`, `vendor.capabilities_updated`,
`vendor.workloads_updated`, `vendor_account.created`,
`vendor_account.updated`, `vendor_account.disabled`,
`vendor_credential.created`, `vendor_credential.updated`,
`vendor_credential.rotated`, `vendor_credential.enabled`,
`vendor_credential.disabled`, `vendor_credential.deleted`). Audit
metadata never includes a secret value, ciphertext, an encryption key, or
a `secretRef`.

**Vendor account health observations are deliberately not audit events**
(Block 09) — `audit_events` is for administrative actions; a health
observation is frequent operational telemetry, and
`vendor_account_health_events` (see `docs/DATABASE.md`) is already that
history. See `docs/PROVIDER_HEALTH.md`.

## Model Catalog (Block 07)

All Model Catalog responses are JSON, camelCase, and share the standard
error format below on failure. Every route lives under `/v1` and, like
every control-plane route, requires `Authorization: Bearer
<INHOUSE_ADMIN_TOKEN>` (see "Authentication"). Full schema/persistence detail is in
`docs/DATABASE.md`; this section documents the HTTP contract only.

**Scope:** this block persists model *configuration* — which
`provider_model_id` a vendor exposes, the Inhouse-facing alias, display
name, context window, status, and which capabilities/workloads it's
associated with. It does not call any provider, does not validate a
model id against the vendor, and does not implement routing or
execution — nothing reads this configuration to make a live decision yet.

### Models

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/models` | Optional `?vendorId=`, `?status=enabled\|disabled`, `?capabilityId=`, `?workloadId=`, `?search=` (matches display name, Inhouse alias, or provider model id), `?limit=` (default 50, max 200), `?offset=` |
| `GET` | `/v1/models/:id` | Includes nested `capabilities`, `workloads` |
| `POST` | `/v1/models` | Body: `{ vendorId, providerModelId, inhouseAlias, displayName, contextWindow?, status?, capabilityIds?, workloadIds? }`. Optionally assigns capabilities/workloads at creation, in the same transaction |
| `PATCH` | `/v1/models/:id` | Partial update; at least one field required. `vendorId` cannot be changed — see "Immutability" |
| `DELETE` | `/v1/models/:id` | **Soft-disable** (`status` → `disabled`), not a row deletion — same reasoning as vendor deletion |
| `PUT` | `/v1/models/:id/capabilities` | Replaces the full assigned-capability set (body: `{ "capabilityIds": [...] }`) |
| `PUT` | `/v1/models/:id/workloads` | Replaces the full allowed-workload set (body: `{ "workloadIds": [...] }`) |

A model status is one of `enabled` / `disabled` — enforced by request
validation, not a database constraint (see `docs/DATABASE.md`). There is
no separate "enable" endpoint: re-enabling a disabled model is a `PATCH`
with `{ "status": "enabled" }`.

`inhouseAlias` must be a lowercase, dash-separated identifier (e.g.
`my-model-alias`) and is unique across all models. The pair
`(vendorId, providerModelId)` is also unique — the same provider model id
may be registered under different vendors, but not twice under the same
vendor.

### Immutability

`vendorId` cannot be changed after a model is created — a `PATCH` that
includes `vendorId` is rejected with a `400`. Re-parenting a model to a
different vendor is not supported in this block; create a new model
under the intended vendor instead.

### Validation

`GET /v1/models` filters are validated the same way regardless of source
(query strings arrive as strings): `vendorId`/`capabilityId`/`workloadId`
must be UUIDs, `status` must be a known value, `limit` must be an integer
in `1..200`, `offset` must be a non-negative integer. Referencing an
unknown vendor, capability, or workload id on create/update/assignment
returns a structured `400 VALIDATION_ERROR` — never a `500`.

### Audit Trail

Model create, update, status-change, and assignment operations are
recorded to `audit_events` (`model.created`, `model.updated`,
`model.enabled`, `model.disabled`, `model.capabilities_updated`,
`model.workloads_updated`).

## Routing Policy (Block 11)

All Routing Policy responses are JSON, camelCase, and share the standard
error format below on failure. Every route lives under `/v1` and requires
the administrative token (see "Authentication"). Full schema/eligibility
detail is in `docs/ROUTING_POLICY.md`; this section documents the HTTP
contract only.

**Scope:** this block reads and manages routing *configuration*
(`routing_tiers`/`routing_fallback_rules`, unchanged since Block 05) and
computes a deterministic, explainable dry-run decision over it. **It
never calls a provider, never decrypts a credential, and never writes a
usage ledger entry or a health event.**

### Tiers and Fallback Rules

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/routing/workloads/:workloadId` | Combined view: `{ workload, tiers, fallbackRules }` |
| `GET` | `/v1/routing/workloads/:workloadId/tiers` | |
| `POST` | `/v1/routing/workloads/:workloadId/tiers` | Body: `{ vendorId, modelId, tierNumber, priority?, enabled?, timeoutOverrideMs?, maxAttempts? }`. Requires the vendor and model to already be assigned to the workload |
| `PATCH` | `/v1/routing/workloads/:workloadId/tiers/:tierId` | Partial update of `priority`/`enabled`/`timeoutOverrideMs`/`maxAttempts`; at least one field required. `vendorId`/`modelId`/`tierNumber`/`workloadId` are immutable — create a new tier instead |
| `DELETE` | `/v1/routing/workloads/:workloadId/tiers/:tierId` | **Soft-disable** (`enabled` → `false`), not a row deletion |
| `GET` | `/v1/routing/workloads/:workloadId/fallback-rules` | |
| `POST` | `/v1/routing/workloads/:workloadId/fallback-rules` | Body: `{ fromTierId, toTierId, conditionType, conditionConfig?, priority?, enabled? }`. Both tiers must already belong to `workloadId`; `fromTierId`/`toTierId` cannot be equal |
| `PATCH` | `/v1/routing/workloads/:workloadId/fallback-rules/:ruleId` | Partial update of `conditionType`/`conditionConfig`/`priority`/`enabled` |
| `DELETE` | `/v1/routing/workloads/:workloadId/fallback-rules/:ruleId` | **Soft-disable** (`enabled` → `false`) |

`conditionType` is one of a fixed vocabulary:
`on_error | on_timeout | on_rate_limit | on_5xx | on_auth_failure |
on_invalid_response` (mirrors the per-condition retry flags Block 06
already added to `vendors`) — see `docs/ROUTING_POLICY.md`, "Fixed
Condition Vocabulary". Nothing evaluates this field to trigger a real
fallback.

### Preview / Dry-Run

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/routing/preview` | Body: `{ workloadId, modelId?, capabilityIds? }`. Returns `{ decision }` |

`decision` shape:

```json
{
  "workload": { "id": "...", "slug": "chat", "displayName": "Chat", "status": "enabled" },
  "requested": { "modelId": null, "capabilityIds": [] },
  "candidates": [
    {
      "tierId": "...",
      "tierNumber": 1,
      "priority": 5,
      "tierEnabled": true,
      "vendor": { "id": "...", "slug": "...", "displayName": "...", "status": "enabled" },
      "model": { "id": "...", "inhouseAlias": "...", "displayName": "...", "status": "enabled" },
      "health": "healthy",
      "accounts": [{ "id": "...", "slug": "...", "displayName": "...", "status": "enabled", "health": "healthy" }],
      "retryPolicy": { "timeoutMs": 5000, "maxAttempts": 3, "retryOnTimeout": true, "retryOnRateLimit": false, "retryOn5xx": false, "retryOnAuthFailure": false, "retryOnInvalidResponse": false },
      "outgoingFallbackRules": [],
      "eligible": true,
      "reasons": []
    }
  ],
  "selectedCandidate": { "...": "same shape as a candidate, or null" },
  "outcome": "selected",
  "fallbackRules": [],
  "generatedAt": "2026-09-20T00:00:00.000Z"
}
```

`outcome` is one of `selected` / `no_eligible_candidate` /
`no_tiers_configured`. `reasons` accumulates every applicable exclusion
reason for an ineligible candidate (see `docs/ROUTING_POLICY.md`,
"Eligibility Engine", for the full reason vocabulary) — never just the
first one found. The response never includes a credential, secret,
ciphertext, or raw provider data of any kind.

**This is configuration simulation only.** It never contacts a provider,
never executes an LLM request, never consumes a credential, and never
creates a usage ledger entry or a health event — see
`docs/ROUTING_POLICY.md`, "Preview / Dry-Run Semantics".

### Audit Trail

Routing tier/fallback-rule create, update, and enable/disable operations
are recorded to `audit_events` (`routing_tier.created`,
`routing_tier.updated`, `routing_tier.enabled`, `routing_tier.disabled`,
`routing_fallback_rule.created`, `routing_fallback_rule.updated`,
`routing_fallback_rule.enabled`, `routing_fallback_rule.disabled`). A
preview call records no audit event — it changes nothing.

## Request ID / Correlation

Every request is assigned a request ID: the incoming `x-request-id` header
is used verbatim if present, otherwise one is generated
(`crypto.randomUUID()`). Every response — success or error — echoes it back
via the `x-request-id` response header, and every error body includes it
as `error.requestId` for support/log correlation.

## Error Format

All error responses (4xx and 5xx) share one shape:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Route GET /unknown not found",
    "requestId": "6a1b3c9e-..."
  }
}
```

- `code` is a stable machine-readable string.
- `message` is safe for display; 5xx responses always use a generic message
  ("An unexpected error occurred.") — internal details are logged
  server-side, never returned to the client. Stack traces are never
  included in any response, in any environment.
- `requestId` matches the `x-request-id` response header.

## Configuration

All runtime configuration is environment-driven (see the repository root
`.env.example`); nothing below has a value hardcoded in source:

| Variable | Default | Purpose |
|---|---|---|
| `INHOUSE_API_ENV` | `development` | Deployment stage: `development`, `test`, `staging`, `production` |
| `INHOUSE_API_HOST` | `0.0.0.0` | Bind address inside the container |
| `INHOUSE_API_PORT` | `8092` | Listen port (also the Docker Compose host-published port, loopback-only) |
| `INHOUSE_API_LOG_LEVEL` | `info` | Pino/Fastify log level |
| `INHOUSE_API_PREFIX` | `/v1` | Versioned route prefix |
| `INHOUSE_API_BODY_LIMIT` | `1048576` (1 MiB) | Max request body size, in bytes |
| `INHOUSE_API_CORS_ORIGINS` | *(empty)* | Comma-separated CORS allowlist; empty disables cross-origin access entirely |

Invalid values (e.g. a non-numeric port, an unrecognized log level) cause
the process to fail fast at startup with a descriptive error rather than
running in an undefined state.

The Vendor System additionally requires the `INHOUSE_DB_*` variables
documented in `docs/DATABASE.md` — the process fails fast at startup if
`INHOUSE_DB_PASSWORD` is missing, for the same fail-fast reason. Block 08
adds `INHOUSE_CREDENTIAL_ENCRYPTION_KEY` (the credential vault's master
key), required for the same reason whenever the database-backed routes
are enabled — see `docs/CREDENTIAL_VAULT.md`.

## Authentication

Two separate trust boundaries, never interchangeable:

- **Control plane** — every route except the four below (vendors, accounts,
  credentials, capabilities, workloads, models, routing, provider health,
  `/v1/api-keys*`, `/v1/usage`) requires `Authorization: Bearer
  <INHOUSE_ADMIN_TOKEN>`. Missing or wrong token: 401 `UNAUTHENTICATED`
  (checked before body validation). No token configured on the server: 503
  `ADMIN_AUTH_NOT_CONFIGURED` (fail closed). The guard is one shared
  `onRequest` hook (`requireAdmin`, `plugins/adminAuth.ts`) applied per route
  module.
- **Execution plane** — `POST /v1/chat/completions` and `POST /v1/messages`
  require an `ihk_…` client API key and workload authorization; see
  [EXECUTION.md](EXECUTION.md).
- **Public** — `GET /health`, `/ready`, `/v1/health`, `/v1/ready` (Docker
  health checks); no credential.

Binding to `127.0.0.1` is defense in depth, not authorization.

## Logging

Structured JSON logs (Pino) include timestamp, request ID, HTTP method,
route, status code, and response time. `Authorization` and `Cookie`
request headers, `x-api-key`, and common credential-shaped body fields
(`password`, `token`, `apiKey`, `secret`) are redacted (`[Redacted]`) at
the logger level — never written to logs, even at debug level.


## Execution & API keys (Block 12)

See [EXECUTION.md](EXECUTION.md) for `POST /v1/chat/completions`, `POST /v1/messages` (client-key authenticated, workload-scoped, streaming and tool-capable) and the admin-token-guarded `/v1/api-keys*` and `/v1/usage`.
