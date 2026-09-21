# Inhouse Provider Account & Health Foundation (Block 09)

This document is the deep-dive on Block 09. `docs/API.md` documents the
HTTP contract; `docs/DATABASE.md` documents the schema. This document
explains the account model, the health model, the provider-adapter
boundary, and what Block 09 deliberately does not do.

## What Block 09 Establishes

A place to observe and read a vendor account's operational health —
sitting between the already-locked Vendor/Model/Credential foundation
and a future routing/execution engine. **Nothing in this block makes a
network call, calls a provider, sends a credential anywhere, or executes
routing/fallback/model logic.** Every health row that exists after this
block was written by a test or an operator calling
`ProviderHealthService` directly — never by an actual check.

## Account Model: Reused, Not Duplicated

`vendor_accounts` (Block 05) already represents provider account
identity — `id`, `slug`, `display_name`, `status`,
`external_account_ref`, timestamps. Block 09 adds **no columns** to it.
The relationship is:

```
Vendor
  └── Vendor Account
         ├── Credential(s)        (Block 08, vendor_account_id FK)
         └── Health                (Block 09, vendor_account_id FK)
                ├── current snapshot (vendor_account_health)
                └── observation history (vendor_account_health_events)
```

(Models, capabilities, and workloads relate to a **vendor** or a
**model** directly, not to a specific vendor account — see
`docs/DATABASE.md`'s entity list. A diagram suggesting otherwise would
be describing an idealized shape, not this schema.)

### Health vs. `status`: two different concepts, not one

`vendor_accounts.status` is **operator intent** — should this account be
used. Health is an **observed fact** — is it actually working right now.
Conflating them into one field would mean an operator's manual
enable/disable choice gets silently overwritten by automated
observations (or vice versa) — exactly the "overlapping status systems"
this design avoids. They are stored, validated, and read independently.

## Health Model

Two tables (migration `0012`):

- **`vendor_account_health`** — one row per account (upserted), the
  current computed snapshot: `status`, `consecutive_failures`,
  `last_checked_at`, `last_success_at`, `last_failure_at`,
  `last_latency_ms`, `last_error_category`, `last_safe_error_code`.
- **`vendor_account_health_events`** — append-only observation history,
  one row per recorded observation, indexed on
  `(vendor_account_id, checked_at DESC)` for "most recent N" reads.

**No row for an account means `"unknown"`** — never observed. This is
represented by the *absence* of a `vendor_account_health` row, not a
stored enum value; `GET .../health` synthesizes the `"unknown"` response
shape when `ProviderHealthRepository.findByVendorAccountId` returns
`null`. `status` in the database is therefore only ever one of
`healthy` / `degraded` / `unhealthy`.

### Consecutive failures

`consecutive_failures` increments only when an observation's status is
`"unhealthy"`, and resets to `0` on any `"healthy"` or `"degraded"`
observation — a `"degraded"` result means the account is still working,
just not perfectly, so it doesn't count as a failure streak.

### Why no raw error body, request data, or metadata blob

Provider error responses can contain request headers (which could
include an authorization header), request bodies (which could include a
prompt), or other data that has no business being retained in a health
table. Block 09 deliberately has **no JSONB/text blob column** on either
health table — there is nothing to accidentally overflow with sensitive
data, by construction. Instead, `error_category` is a fixed,
provider-agnostic enum (`authentication`, `authorization`, `rate_limit`,
`timeout`, `network`, `provider_error`, `configuration`, `unknown`) and
`safe_error_code` is a short, technical code (e.g. an HTTP status like
`"429"` or a network errno-style string like `"ETIMEDOUT"`) — never a
provider's full response text. Mapping whatever a real provider actually
returns onto this fixed set is a future adapter's job.

## Provider Adapter Boundary

`backend/src/services/providerAdapter.ts` defines the interface a real
adapter implements. As originally written in Block 09:

```ts
interface ProviderAdapter {
  checkHealth(secret: string): Promise<ProviderHealthCheckResult>;
}
```

**Block 10 extended this** (see `docs/PROVIDER_ADAPTERS.md` for the full
current shape) — `checkHealth` gained a `config: ProviderAdapterConfig`
parameter (`{ baseEndpoint, timeoutMs }`), because a protocol-generic
adapter cannot know which vendor's endpoint to call without it, and the
interface gained an `execute()` method for request/response
normalization. Nothing implemented the interface as of Block 09, so
extending it was a safe, additive change, not a breaking one.

`ProviderHealthCheckResult`'s shape (`status`, `latencyMs`,
`errorCategory`, `safeErrorCode`) is exactly what
`ProviderHealthService.recordObservation()` expects as input — the
seam between "an adapter observed reality" and "the health service
persisted it" is explicit and provider-agnostic. **Block 09 implemented
neither the interface's real behavior nor any concrete adapter** — no
OpenAI/Anthropic/Gemini/etc. adapter, no `if (vendorType === "...")`
branching anywhere in this codebase. **Block 10 adds the first real
implementation** (`OpenAiCompatibleAdapter`, for the `"openai-compatible"`
*protocol* — never a business-provider-specific class), and proves the
full seam works in `test/db/adapterHealthIntegration.test.ts`, but still
wires nothing into a running route or scheduled job — see
`docs/PROVIDER_ADAPTERS.md`.

### Credential integration

An adapter's `checkHealth(secret, config)` receives its secret from
Block 08's existing narrow boundary,
`services/credentialSecretAccess.ts`'s `getDecryptedCredentialSecret` —
neither Block 09 nor Block 10 duplicates that decryption logic, adds
another secret store, or exposes a decrypted credential anywhere. That
function's existing safe default carries over unchanged: **a disabled
credential's secret cannot be decrypted**, so an adapter cannot check
health using a disabled credential either (see
`test/db/adapterHealthIntegration.test.ts`).

## Why No Manual Health-Write Endpoint

There is no `POST`/`PATCH` that lets a caller record an arbitrary
observation over HTTP. Recording one (`ProviderHealthService.recordObservation`)
is an internal service method; exposing it directly would let any caller
fabricate an account's health with no real check behind it — a
data-integrity and trust problem. Originally (Block 09) only tests called
it. Since Block 14A the one HTTP write path is the authenticated
**verification action** `POST .../verify` (see "Admin verification"
below): it runs a real, bounded adapter health check and persists the
normalized result through `recordObservation`. Callers can trigger a
check but can never choose the resulting status.

## Disabled-Account Behavior

Recording a health observation works the same regardless of whether the
vendor account's administrative `status` is `enabled` or `disabled` —
persisting the fact "this account was (un)healthy at this time" is
legitimate history, not a decision about whether to *use* the account.
That policy question belongs to whatever calls `recordObservation` (a
future adapter would reasonably choose to skip disabled accounts), not
to the persistence/read layer. This is a deliberate, tested choice (see
`test/db/providerHealth.test.ts`), not an oversight — and it does not
change Block 08's separate, security-motivated rule that a *disabled
credential's secret* can never be decrypted.

## Audit Trail

Health observations are **not** written to `audit_events`. That table
records administrative actions (an operator created/updated/disabled
something); a health observation is frequent operational telemetry
generated by (eventually) automated checks, not an operator's decision.
`vendor_account_health_events` is already the appropriate append-only
history for this data — duplicating it into the audit log would add
noise without adding information.

## What Block 09 Does *Not* Implement

> **Superseded in part by Block 10** — see `docs/PROVIDER_ADAPTERS.md`.
> Block 10 implements a real `ProviderAdapter` (`OpenAiCompatibleAdapter`)
> and proves the credential → adapter → `ProviderHealthService` seam
> end-to-end in tests, but still wires none of it into a running route or
> scheduled job. Everything below that isn't explicitly called out as
> superseded remains true after Block 10.

- ~~Any real provider adapter (OpenAI, Anthropic, Gemini, or
  otherwise)~~ — Block 10 adds the first one, `OpenAiCompatibleAdapter`,
  for the `"openai-compatible"` *protocol* (not any one business
  provider). See `docs/PROVIDER_ADAPTERS.md`.
- ~~Any network call to any provider~~ — Block 10's adapter makes real
  (test-only, never live-provider) HTTP calls. **Still true: no provider
  health-check endpoint** — there remains no route that triggers one.
- Routing, model selection, priority, fallback, failover, load
  balancing, cost optimization, or quota enforcement.
- `/chat/completions`-style execution, Claude Code compatibility, prompt
  forwarding, or response normalization.
- Usage/cost billing.
- A write endpoint for caller-supplied health observations (see "Why No Manual Health-Write Endpoint"; the verification action added in Block 14A runs a real check instead).
- Any change to `vendor_accounts`, `vendor_credentials`, or any Block
  05–08 table.

## Admin verification (Block 14A)

`POST /v1/vendors/:id/accounts/:accountId/verify` (admin token only) runs
`ProviderVerificationService`: validate vendor/account/enabled state/protocol
adapter/enabled credential (all before any decryption), decrypt via
`getDecryptedCredentialSecret`, call the adapter's `checkHealth()` once with
the vendor's `timeout_ms` (default 30s), then record through
`ProviderHealthService.recordObservation` (`source: "adapter"`) plus a
`vendor_account.verified` audit event (ids, protocol, status, safe
category/code, latency, request id — never a secret or provider body).
Configuration failures return 404/409 and record nothing. A credential that
cannot be decrypted records an `unhealthy`/`configuration` observation
(`CREDENTIAL_UNAVAILABLE`) and never contacts the provider. This is not
execution: no routing, retry, fallback, usage ledger or client keys.

## Readiness and credential test timestamps (Block 14B-1)

`GET .../readiness` derives an operational readiness from existing rows (see
"Account readiness" in `docs/API.md`); it reads the persisted health snapshot
and never records health. `POST .../verify` now also stamps the selected
credential's `last_tested_at` (every attempt) and `last_successful_at`
(`healthy` only) via the existing `markTested`. Still exactly one
`checkHealth()` per verification, no retry/fallback.

## Frontend account operations (Block 14B-2)

The Vendors page's Credential tab is the operational surface for an
account. It adds no backend behavior; every value comes from an existing
endpoint:

| UI element | Endpoint |
|---|---|
| Readiness panel and account-list badges | `GET .../accounts/:accountId/readiness` |
| Current health | `GET .../accounts/:accountId/health` |
| Health history (collapsed until expanded, last 20) | `GET .../accounts/:accountId/health/events?limit=20` |
| Verify Account | `POST .../accounts/:accountId/verify` |
| Enable / Disable Account (disable asks for confirmation) | `PATCH` `{status:"enabled"}` / `DELETE .../accounts/:accountId` |
| Edit Account (name, slug, external reference; empty reference is sent as `null`) | `PATCH .../accounts/:accountId` |
| Credentials for the account | `GET/POST/PATCH/DELETE /v1/vendors/:id/credentials` |

Rules the UI follows:

- **Readiness is rendered, never computed.** `degraded` health appears as
  readiness `ready` / `last_check_degraded`, exactly as the backend reports.
- **No optimistic state.** After an account write the page re-reads the
  vendor, readiness and health; after a credential write, credentials and
  readiness; after verification, readiness, health, history and credentials.
  Refresh is manual — there is no polling.
- **Verification result and refresh failure are separate.** If verification
  succeeded but a follow-up read failed, the result stays a success and a
  note names the reads that could not be refreshed.
- **Race safety.** Async results are stored under the account id that
  requested them and stale or superseded responses are dropped, so a late
  response for one account never appears under another.
- **No secret material in the UI.** The API client drops the external
  `secretRef` from credential responses on receipt; credentials are shown
  as type, mode (Inhouse Vault / External Reference), the vault's masked
  identifier, status and test timestamps. Typed secrets are cleared after
  submit and discarded when the operator switches accounts.
- The control plane uses the existing admin token only; an `ihk_` client
  key is never used or accepted for these calls.
