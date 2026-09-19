# Inhouse API (Block 04 — Foundation, persistence added in Block 05)

## Status

This is the backend/API **boundary foundation** only. No authentication,
vendors, models, routing, provider adapters, telemetry, or accounting
exists yet. Those are later blocks. `/root/adorbis-api` is a separate,
external service — Inhouse does not call it yet and this document does
not cover it.

Block 05 added a PostgreSQL persistence layer to the repository (SQL
migrations, a dedicated Inhouse schema, and typed repositories — see
`docs/DATABASE.md`). **No current HTTP route in this API uses it yet.**
The distinction matters:

- **Persistence exists** as a foundation: migrations, schema, and
  repositories are real and tested, independent of this HTTP layer.
- **This API's routes remain database-free in practice** — the health and
  readiness endpoints below never depend on the database (by design, so
  they stay reliable as liveness/readiness probes), and no route performs
  database-backed CRUD. No pool is even opened when the API process
  starts.
- Database-backed API functionality (routes that read or write through
  the repositories) is explicitly out of scope until a later block wires
  it up.

## Service Purpose

`inhouse-api` is the Inhouse product's own backend. Its HTTP surface is
provider-neutral and, at this stage, database-free in practice: it exists
to establish the API contract (versioning, health/readiness, error shape,
request correlation, logging, and baseline security headers/CORS) that
later blocks build on. The Block 05 persistence layer lives alongside
this service in the same repository but is not yet called from any route.

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
Future functional endpoints (`/v1/auth`, `/v1/vendors`, `/v1/models`,
`/v1/routing`, `/v1/executions`, `/v1/usage`, ...) will be added under
`/v1` in later blocks — none of them exist yet.

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
