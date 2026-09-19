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

## Why No Write Endpoint

The API only exposes `GET .../health` and `GET .../health/events` —
there is no `POST`/`PATCH` to record an observation over HTTP. Recording
one (`ProviderHealthService.recordObservation`) is a plain internal
service method, called directly by tests today and, later, by a real
provider adapter. Exposing it as a public endpoint in this block would
let any caller fabricate an account's health with no real check behind
it — a data-integrity and trust problem with no corresponding benefit,
since nothing in this codebase can perform a real check yet anyway.

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
- A write endpoint for health observations (see "Why No Write Endpoint").
- Any change to `vendor_accounts`, `vendor_credentials`, or any Block
  05–08 table.
