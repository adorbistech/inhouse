# Inhouse Database (Block 05 — Persistence Foundation, extended in Block 06, Block 07, Block 08, and Block 09)

## Status

Block 05 established **persistence only** (no API surface over it). Block
06 added the first real data-driven service on top of it — the Vendor
System (`docs/API.md`) — plus a schema extension (migration `0010`) for
vendor-level priority, retry flags, and capability/workload assignment.
Block 07 added a second data-driven service, the Model Catalog
(`docs/API.md`), entirely on Block 05's existing `models` /
`model_capabilities` / `model_workloads` tables — no new migration was
required. **Block 08 extends `vendor_credentials` (migration `0011`)
with a real, INHOUSE-managed authenticated-encryption vault** — see
`docs/CREDENTIAL_VAULT.md` for the full design; this document covers the
schema change only. **Block 09 adds `vendor_account_health` and
`vendor_account_health_events` (migration `0012`)** — observed
operational health for a vendor account, read-only over HTTP, with the
adapter interface a later block will implement — see
`docs/PROVIDER_HEALTH.md`.
**Block 10 adds no schema change at all** — inspection confirmed the
existing `vendors`/`vendor_accounts`/`vendor_credentials`/`models`
schema already fully represents provider identity, protocol, endpoint,
accounts, credentials, and models; the protocol → adapter mapping it adds
is code (`backend/src/services/adapters/adapterRegistry.ts`), never a
table. See `docs/PROVIDER_ADAPTERS.md`.

Still not implemented, in any block so far:

- ~~provider integrations (real calls to a vendor's API)~~ — Block 10
  adds the first one (`OpenAiCompatibleAdapter`, for the
  `"openai-compatible"` protocol), but nothing in this codebase calls it
  from a route yet. See `docs/PROVIDER_ADAPTERS.md`.
- model execution
- a routing engine (routing *configuration* is persisted; nothing
  executes it)
- API authentication
- Claude Code integration
- accounting/cost calculations

Those remain later blocks. This document covers the database layer they
will build on: an isolated Postgres service, SQL migrations, schema, and
typed repositories.

## Database Isolation

Inhouse uses its **own dedicated PostgreSQL Docker service** — never the
host's PostgreSQL, and never any other existing container:

- Service/container name: `inhouse-postgres` (image `postgres:16-alpine`)
- Network: `inhouse-net` (the same dedicated network `inhouse-frontend` and
  `inhouse-api` already use)
- Named volume: `inhouse-postgres-data`
- **No host port is published.** `inhouse-api` reaches the database only
  over `inhouse-net` via Docker DNS, using the service name
  `inhouse-postgres` as the host.

This was a deliberate choice over reusing either PostgreSQL instance
already listening on the host (`127.0.0.1:5432`, the host's own PostgreSQL
service, and `127.0.0.1:5433`, `adorbis-core-test-postgres`, an unrelated
existing Docker container). Neither was inspected, connected to, or
assumed to be related to Inhouse. Not publishing a host port at all removes
any possibility of colliding with those, or any future host service, by
construction — there's no port number to pick.

For local development or debugging outside Docker (e.g. a DB GUI), a
developer can temporarily publish a port to their own compose override —
this repository does not do so by default.

## Configuration

All values are environment-driven (`backend/src/db/config.ts`,
`loadDbConfig`). No default is provided for the password — a missing
`INHOUSE_DB_PASSWORD` fails startup immediately rather than falling back to
a guessable value.

| Variable | Default | Purpose |
|---|---|---|
| `INHOUSE_DB_HOST` | `inhouse-postgres` | DB host (the Compose service name) |
| `INHOUSE_DB_PORT` | `5432` | DB port |
| `INHOUSE_DB_NAME` | `inhouse` | Database name |
| `INHOUSE_DB_USER` | `inhouse_app` | Database user |
| `INHOUSE_DB_PASSWORD` | *(none — required)* | Database password |
| `INHOUSE_DB_SCHEMA` | `inhouse` | Dedicated schema/namespace (see below) |
| `INHOUSE_DB_POOL_MIN` | `2` | Minimum pool connections |
| `INHOUSE_DB_POOL_MAX` | `10` | Maximum pool connections |
| `INHOUSE_DB_SSL` | `false` | Require TLS when connecting |

See the repository root `.env.example` — placeholders only, no real values.

## Schema / Namespace

All Inhouse tables live in a dedicated Postgres **schema** (default name
`inhouse`, configurable via `INHOUSE_DB_SCHEMA`), not `public`. The pool
(`src/db/client.ts`) pins `search_path` to `<schema>,public` at connection
time, so repository code never has to schema-qualify table names, and the
schema can be renamed via configuration without touching SQL.

## Identifiers

Every table uses a `UUID` primary key, generated with Postgres's built-in
`gen_random_uuid()` (available natively since Postgres 13 — no `pgcrypto`
extension needed, and the compose service pins `postgres:16-alpine`).
UUIDs were chosen over serial integers so future distributed writers
(multiple API instances, offline-generated records) never collide on ID
assignment.

## Migrations

Location: `backend/src/db/migrations/*.sql`, numbered and applied in
filename order (`0001_...`, `0002_...`, ...). The runner is
`backend/src/db/migrate.ts`.

- **Tracking table:** `schema_migrations` (inside the Inhouse schema),
  recording `name`, a SHA-256 `checksum` of the file's contents, and
  `applied_at`.
- **Repeat-safe:** re-running `db:migrate` when nothing is pending is a
  no-op (`No pending migrations. N already applied.`).
- **Checksum drift detection:** if an already-applied migration file's
  contents change, the runner refuses to proceed — migrations are
  immutable once applied; a change means writing a new migration, not
  editing an old one.
- **No silent failures:** each migration runs inside its own
  `BEGIN`/`COMMIT`. On error, it rolls back, logs which file failed, and
  stops before applying any later file — the CLI exits non-zero.
- **Namespace:** the runner creates the Inhouse schema (`CREATE SCHEMA IF
  NOT EXISTS`) if it doesn't exist yet, and the tracking table lives inside
  that schema, not `public`.

Commands (run from `backend/`):

```
npm run db:migrate          # apply pending migrations
npm run db:migrate:status   # list applied/pending without changing anything
```

**Block 06 migration:** `0010_vendor_priority_retry_and_assignments.sql`
adds `priority` and five per-condition `retry_on_*` boolean columns to
`vendors`, plus two new join tables: `vendor_capabilities` and
`vendor_workloads`. Why: Block 05's `capabilities`/`workloads` reference
data was only ever joined to *models* (`model_capabilities`,
`model_workloads`) — the Vendor System needs a distinct vendor-level
edge (which capabilities a vendor advertises, which workloads it's
allowed to serve), not a duplicate of the model-level one. Nothing
existing was altered or renamed; this is purely additive (`ALTER TABLE
... ADD COLUMN`, two new `CREATE TABLE`s), applied as one migration file,
transactional and repeat-safe like every other migration here.

**Block 08 migration:** `0011_vendor_credential_secret_vault.sql` makes
`vendor_credentials.secret_ref` nullable and adds six columns
(`secret_ciphertext`, `secret_iv`, `secret_auth_tag`, `secret_fingerprint`,
`secret_masked`, `secret_encryption_version`) plus two `CHECK` constraints
that together enforce "exactly one secret storage mode" *at the database
layer*, not just in application code — see "Credential Vault" below and
`docs/CREDENTIAL_VAULT.md` for the full design. Why extend
`vendor_credentials` rather than add a new table: it already existed
specifically as the landing spot for this ("the vault/encryption
mechanism itself belongs to a later block" — Block 05's original
comment); a second, parallel credential table would have duplicated the
vendor-account relationship and lifecycle logic that already exist here.
Existing rows (all `secret_ref`-mode) remain valid without a backfill.

**Block 09 migration:** `0012_vendor_account_health.sql` adds two new
tables — `vendor_account_health` (current snapshot, one row per account)
and `vendor_account_health_events` (append-only history) — both keyed to
`vendor_account_id`. `vendor_accounts` itself is unchanged: its existing
`id`/`slug`/`display_name`/`status`/`external_account_ref` already fully
represent account identity, so no columns were added to it. See
"Provider Account Health" below and `docs/PROVIDER_HEALTH.md`.

## Schema — Entities

All tables include `created_at`/`updated_at` (UTC, `TIMESTAMPTZ`, default
`now()`); tables with `updated_at` get an automatic trigger
(`set_updated_at`) that refreshes it on every `UPDATE`.

- **vendors** — vendor registry (slug, type, protocol, endpoint, billing,
  tiering, retry/timeout defaults, priority). No provider names are
  seeded. Lifecycle status is one of `enabled` / `disabled` /
  `unavailable` (enforced at the API validation layer — the column
  itself remains plain `TEXT`, unconstrained by the database, matching
  Block 05's original design). **`protocol` is also what Block 10's
  code-defined adapter registry looks adapters up by** — whether a given
  `protocol` value has a registered adapter is never stored on this row;
  see `docs/PROVIDER_ADAPTERS.md`.
- **vendor_accounts** — one or more accounts per vendor.
- **vendor_account_health** / **vendor_account_health_events** (Block 09)
  — observed operational health for an account: a current snapshot
  (status, consecutive failures, last latency/error) and its append-only
  observation history. Distinct from `vendor_accounts.status`, which is
  operator intent, not an observed fact. No raw provider error body or
  request/response data is ever stored — see `docs/PROVIDER_HEALTH.md`.
- **vendor_capabilities** / **vendor_workloads** (Block 06) — which
  capabilities a vendor advertises and which workloads it may serve, as
  data. Distinct from `model_capabilities`/`model_workloads`, which
  describe a *model's* capabilities/workloads, not a vendor's.
- **vendor_credentials** — credential lifecycle (status, last
  tested/successful) plus its secret, in exactly one of two mutually
  exclusive modes (enforced by a `CHECK` constraint — Block 08, migration
  `0011`): a caller-supplied external `secret_ref` (Block 05/06, unchanged
  — never a secret itself), or INHOUSE-vault-managed encrypted material
  (`secret_ciphertext`/`secret_iv`/`secret_auth_tag`, AES-256-GCM).
  **Never a plaintext secret column, in either mode.** Full design in
  `docs/CREDENTIAL_VAULT.md`.
- **models** — provider model identifiers mapped to an Inhouse alias, per
  vendor. No provider/model names are seeded. `(vendor_id,
  provider_model_id)` and `inhouse_alias` are both unique. CRUD over this
  table is exposed by the Model Catalog (Block 07, `docs/API.md`);
  `vendor_id` is immutable after creation at the API layer.
- **capabilities** / **model_capabilities** — generic capability tags,
  joined to models many-to-many. The Block 07 Model Catalog exposes
  `PUT /v1/models/:id/capabilities` to replace a model's full assigned set.
- **workloads** / **model_workloads** — data-driven workload records,
  joined to models many-to-many. The Block 07 Model Catalog exposes
  `PUT /v1/models/:id/workloads` the same way.
- **routing_tiers** — data representation of a workload's tiers (vendor,
  model, priority, timeout/attempt overrides). No routing logic.
- **routing_fallback_rules** — configurable fallback conditions
  (`condition_type` + `condition_config` JSONB) between two tiers. No
  fallback engine evaluates these yet.
- **inhouse_api_keys** — Inhouse-issued keys (never provider credentials).
  Stores `key_hash` only — see "API Key Hashing" below. Authentication
  itself is not implemented.
- **usage_ledger** — per-execution record (tokens, latency, cost fields,
  vendor/model/workload/tier references, error category). No pricing is
  calculated or seeded here — later blocks write the computed values.
- **audit_events** — actor/action/resource/metadata audit trail.
  `metadata` is caller-supplied JSON and must never contain secrets —
  that's a caller responsibility, not something the database enforces.

Foreign keys, unique constraints, and indexes on FK columns and
frequently-filtered columns (`status`, `created_at`) are defined directly
in the migration SQL — see `backend/src/db/migrations/`.

## Repositories

`backend/src/repositories/` has one typed repository per entity group
(`VendorsRepository`, `VendorAccountsRepository`,
`VendorCredentialsRepository`, `ModelsRepository`, `CapabilitiesRepository`,
`WorkloadsRepository`, `RoutingRepository`, `ApiKeysRepository`,
`UsageLedgerRepository`, `AuditEventsRepository`).

Rules:

- Every query is parameterized (`$1`, `$2`, ...) — no string interpolation
  of caller-controlled values, ever (see `test/db/repositories.test.ts`,
  "parameterized queries" test, which asserts an injection-shaped value is
  stored as inert data, not executed).
- Repositories accept a `Queryable` (`src/db/client.ts`) — either a `Pool`
  or a transaction's `PoolClient` — so callers can compose multi-step
  writes atomically via `withTransaction()` without the repository knowing
  about transactions.
- Repositories have no dependency on Fastify. They are plain classes,
  independent of the HTTP layer. No route handler exists yet that calls
  them — that's later work (`No SQL in route handlers`, per
  `docs/DEVELOPMENT_RULES.md`).

## Credential Boundary

`vendor_credentials.secret_ref` is a *reference* (e.g. a vault path or
external ID) — the actual secret value is never written to this database
in any column, table, or JSON blob. Building the vault/encryption
mechanism itself is explicitly out of scope for this block.

## API Key Hashing

`backend/src/lib/apiKeyHash.ts` hashes a raw Inhouse-issued API key with
SHA-256 before it's ever written to `inhouse_api_keys.key_hash`. The raw
key is never persisted, logged, or returned by any repository method.
SHA-256 (rather than a slow/salted password hash like bcrypt or scrypt) is
appropriate specifically because the input is a high-entropy,
server-generated random token, not a user-chosen password — there's no
brute-force dictionary to slow down, and a deterministic hash allows a
direct `key_hash` lookup. This block only builds the hashing boundary;
issuing keys and authenticating requests with them is a later block.

## Test Database Isolation

DB-backed tests never touch the host's PostgreSQL, `inhouse-postgres`
(the dev/prod service), or any other existing service. They use a fully
disposable, Inhouse-only container:

```
npm run test:db:start   # starts `inhouse-postgres-test` (postgres:16-alpine),
                         # a Docker-assigned random host port (127.0.0.1 only),
                         # writes connection info to backend/.test-db.json
                         # (git-ignored)
npm run test:db          # start -> run test/db/**/*.test.ts serially -> stop
npm run test:db:stop     # removes the container and the state file
```

`test/db/*.test.ts` run with `--test-concurrency=1`: several files share
one disposable database and some (e.g. the migration tests) drop and
recreate the schema, which is unsafe to run concurrently against a single
Postgres instance. Regular `npm test` (no Docker required) is unaffected —
it only runs `test/*.test.ts`, which includes plain config/unit tests for
the DB config and the API key hash but never opens a real connection.

## Backup Considerations

Not addressed in this block beyond the named Docker volume
(`inhouse-postgres-data`) persisting data across container
restarts/recreations. A backup/restore strategy (e.g. `pg_dump` on a
schedule) is deferred to a later block once there is real data worth
protecting.

## What Block 05 Did *Not* Implement (superseded where Block 06/07/08/09 adds it)

- ~~HTTP CRUD routes over any of these tables~~ — Block 06 adds the
  Vendor System's CRUD API over `vendors`, `vendor_accounts`,
  `vendor_credentials`, `capabilities`, and `workloads`. Block 07 adds
  the Model Catalog's CRUD API over `models`, plus capability/workload
  assignment (`model_capabilities`/`model_workloads`). See `docs/API.md`.
- ~~A credential vault/encryption mechanism~~ — Block 08 adds it:
  `vendor_credentials` can now store a real provider secret, encrypted at
  rest (AES-256-GCM) by INHOUSE itself. See `docs/CREDENTIAL_VAULT.md`.
  **Provider integrations themselves are still not implemented** — Block
  08 only builds the storage/decrypt boundary; nothing calls a provider
  with a decrypted secret yet.
- ~~A place to observe provider-account health~~ — Block 09 adds
  `vendor_account_health`/`vendor_account_health_events` plus a
  read-only API over them. **Still not implemented: any actual health
  check.** Every row in this block is written by a test or an operator
  calling `ProviderHealthService` directly — Block 09 defines the
  `ProviderAdapter` interface a later block will implement to perform a
  real, network-calling check. See `docs/PROVIDER_HEALTH.md`.
- Model execution or a routing engine — still not implemented; Block
  06/07 persist routing-*adjacent* configuration (vendor priority/retry
  flags, which capabilities/workloads a model supports) but nothing
  executes it. Block 09's health data is exactly the kind of signal a
  future routing engine would consume, but nothing reads it for that
  purpose yet.
- API authentication (issuing/validating `inhouse_api_keys`) — still not
  implemented. (Not to be confused with Block 08's credential vault,
  which protects *provider* secrets, not Inhouse API access.)
- Claude Code integration — still not implemented.
- Cost/pricing calculation or any pricing seed data — still not
  implemented.
- Seed data for any real vendor, model, or provider name — still true in
  Block 09: no vendor, model, credential, or health observation is
  created except through the API/service layer, by an operator or test.
