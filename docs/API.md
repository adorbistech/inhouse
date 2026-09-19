# Inhouse API (Block 04 — Foundation, persistence added in Block 05, Vendor System added in Block 06)

## Status

Authentication, model execution, routing, provider adapters, telemetry,
and accounting still do not exist. Those remain later blocks.
`/root/adorbis-api` is a separate, external service — Inhouse does not
call it yet and this document does not cover it.

Block 05 added a PostgreSQL persistence layer (SQL migrations, a
dedicated Inhouse schema, and typed repositories — see
`docs/DATABASE.md`); at that point no HTTP route used it yet. **Block 06
changes that for one domain: the Vendor System.** The distinction that
matters going forward:

- **Persistence exists and is now reachable over HTTP** for vendors,
  vendor accounts, vendor credential metadata, capabilities, and
  workloads (see "Vendor System" below) — real reads/writes through the
  Block 05/06 schema and repositories.
- **`/health` and `/ready` (and their `/v1` equivalents) remain
  database-free by design** — they never depend on the database, so they
  stay reliable as liveness/readiness probes regardless of the database's
  state. This did not change in Block 06.
- **No route executes a provider call, routing decision, or model
  execution.** The Vendor System persists *configuration* (including
  routing-adjacent fields like priority and retry conditions) — nothing
  reads that configuration to actually route or execute a request yet.
- **No route implements authentication.** Every endpoint below, including
  the Vendor System, is unauthenticated in this block (see
  "Authentication").

## Service Purpose

`inhouse-api` is the Inhouse product's own backend. It establishes the
API contract (versioning, health/readiness, error shape, request
correlation, logging, baseline security headers/CORS — Block 04) and, as
of Block 06, the first real data-driven control-plane service on top of
it (the Vendor System, Block 06) built on the Block 05 persistence layer.
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
every route in this API, is currently unauthenticated (see
"Authentication"). Full schema/persistence detail is in
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

### Vendor Accounts

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/vendors/:id/accounts` | |
| `POST` | `/v1/vendors/:id/accounts` | |
| `PATCH` | `/v1/vendors/:id/accounts/:accountId` | |
| `DELETE` | `/v1/vendors/:id/accounts/:accountId` | **Soft-disable**, same reasoning as vendor deletion |

A vendor may have multiple accounts; nothing in this API assumes a fixed
`accounts[0]` — every account has its own id, slug, and status.

### Vendor Credentials — metadata only, never a secret

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/vendors/:id/credentials` | All credentials across every account belonging to the vendor |
| `POST` | `/v1/vendors/:id/credentials` | Body: `{ vendorAccountId, credentialType, secretRef }` — see below |
| `PATCH` | `/v1/vendors/:id/credentials/:credentialId` | |
| `DELETE` | `/v1/vendors/:id/credentials/:credentialId` | **Hard delete** — safe, since no other table references a credential by id |

**`secretRef` is a reference (e.g. a vault path or external secret-manager
ID), never a plaintext provider API key, bearer token, or password.**
This endpoint never accepts and never returns raw secret material — the
response shape is an explicit whitelist (`id`, `vendorAccountId`,
`credentialType`, `status`, `secretRef`, `createdAt`, `updatedAt`,
`lastTestedAt`, `lastSuccessfulAt`) that cannot grow to include a secret
column by accident. Registering a credential is intentionally a separate
action from creating a vendor — this API never asks for a provider secret
as part of `POST /v1/vendors`. There is no "test connection against the
provider" endpoint in this block; that requires a real provider adapter
(a later block).

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
`vendor_credential.deleted`). Audit metadata never includes a secret
value or a `secretRef`.

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
`INHOUSE_DB_PASSWORD` is missing, for the same fail-fast reason.

## Authentication

**AUTHENTICATION IS NOT IMPLEMENTED YET.** Every route in this block is
unauthenticated. The health/readiness endpoints are intended to stay
public/internal-only even after authentication is added elsewhere, but no
route in this API should be treated as production-secure until a later
block adds real authentication and authorization. Do not expose this
service beyond `127.0.0.1` / the internal Docker network until then.

## Logging

Structured JSON logs (Pino) include timestamp, request ID, HTTP method,
route, status code, and response time. `Authorization` and `Cookie`
request headers, `x-api-key`, and common credential-shaped body fields
(`password`, `token`, `apiKey`, `secret`) are redacted (`[Redacted]`) at
the logger level — never written to logs, even at debug level.
