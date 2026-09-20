# Inhouse Routing Policy & Deterministic Selection Foundation (Block 11)

This document is the deep-dive on Block 11. `docs/API.md` documents the
HTTP contract; `docs/DATABASE.md` documents the (unchanged) routing
schema this block builds on; this document explains the eligibility
model, deterministic ordering, preview semantics, and the explicit
execution boundary Block 11 does not cross.

## What Block 11 Is

A **policy/selection layer** over routing configuration that already
existed from Block 05/06: `routing_tiers` and `routing_fallback_rules`
(migration `0006_routing.sql`), the `RoutingRepository`, and the
priority/retry columns and capability/workload join tables Block 06
added to `vendors`. Block 11 answers:

> Given workload X, what configured candidates are eligible, in what
> order, and why?

## What Block 11 Is Not

It does not answer:

> Send the actual request to provider X.

There is no execution, no fallback *execution*, no retry *execution*, no
credential decryption, no outbound provider HTTP call, and no usage
ledger or health-event write anywhere in this block. See "Execution
Boundary" below.

## No Duplicate Routing Schema

Block 11 adds **zero migrations**. Inspection before building confirmed
the existing schema already carries everything a routing policy layer
needs:

- `routing_tiers` — `workload_id`, `tier_number`, `vendor_id`,
  `model_id`, `priority`, `enabled`, `timeout_override_ms`,
  `max_attempts` (Block 05).
- `routing_fallback_rules` — `workload_id`, `from_tier_id`, `to_tier_id`,
  `condition_type`, `condition_config` (JSONB), `priority`, `enabled`
  (Block 05).
- Vendor-level routing-adjacent configuration — `priority`,
  `retry_on_timeout`, `retry_on_rate_limit`, `retry_on_5xx`,
  `retry_on_auth_failure`, `retry_on_invalid_response`, `timeout_ms`,
  `retry_max_attempts`, `retry_backoff_ms` (Block 06, migration `0010`).
- Eligibility foundations — `vendors`, `models`, `workloads`,
  `capabilities`, `vendor_workloads`, `model_workloads`,
  `vendor_capabilities`, `model_capabilities` (Block 05/06).
- Provider health — `vendor_account_health`/`vendor_account_health_events`
  (Block 09, `docs/PROVIDER_HEALTH.md`).

`RoutingRepository` (`backend/src/repositories/routingRepository.ts`)
gained `updateTier`/`setTierEnabled`/`findFallbackRuleById`/
`updateFallbackRule`/`setFallbackRuleEnabled` — ordinary repository
methods over the existing tables, exactly mirroring
`VendorsRepository`'s/`ModelsRepository`'s patch-column-whitelist
pattern. No new table, no new column.

## Architectural Model

```
Request intent
    |
Workload
    |
Routing policy (RoutingService)
    |
Configured routing tiers (routing_tiers)
    |
Eligibility evaluation
    |
Provider/model candidate set
    |
Health/configuration checks
    |
Deterministic ordering
    |
DRY-RUN ROUTING DECISION
    |
(future execution block)
```

`RoutingService` (`backend/src/services/routingService.ts`) is the one
new service. It never imports `ProviderAdapter`, `AdapterRegistry`, or
`credentialSecretAccess.ts` — the eligibility/ordering/preview logic is
provably incapable of executing anything, not just conventionally
forbidden from doing so.

## Eligibility Engine

For a given workload and an optional requested `modelId`/`capabilityIds`,
each configured `routing_tiers` row becomes one candidate. A candidate
accumulates **every** applicable exclusion reason (not just the first),
so a caller sees the complete picture:

| Reason | Meaning |
|---|---|
| `tier_disabled` | The tier's own `enabled` flag is `false`. |
| `workload_inactive` | The workload's `status` is not `"enabled"`. |
| `vendor_not_found` / `model_not_found` | Defensive — the FK should prevent this. |
| `vendor_disabled` / `model_disabled` | The vendor's/model's `status` is not `"enabled"`. |
| `vendor_workload_mismatch` / `model_workload_mismatch` | The vendor/model is not assigned to this workload (`vendor_workloads`/`model_workloads`). |
| `model_not_requested` | A specific `modelId` was requested and this tier's model doesn't match. |
| `capability_not_supported:<id>` | A requested capability is present in neither the vendor's nor the model's capability assignments. |
| `vendor_unhealthy` | See "Health Interpretation" below. |

A candidate is `eligible` exactly when its `reasons` array is empty.

### Capability Eligibility

A requested capability is satisfied if **either** the vendor
(`vendor_capabilities`) or the model (`model_capabilities`) has it
assigned — a capability can be vendor-wide (e.g. "streaming", true for
every model a vendor serves) or model-specific (e.g. "vision"). Missing
capabilities are reported individually (`capability_not_supported:<id>`
per missing capability), never merged into one opaque reason.

### Health Interpretation

Health is observed **per vendor account** (Block 09,
`vendor_account_health`), but a routing tier references a vendor, not
one specific account. `RoutingService` aggregates a vendor's account
observations into a single signal:

- `"healthy"` — at least one account is healthy.
- `"degraded"` — no account is healthy, but at least one is degraded.
- `"unhealthy"` — every account has been observed and every one is
  unhealthy.
- `"unknown"` — no accounts exist yet, or none have ever been observed.
  **Never silently treated as healthy.**

Only `"unhealthy"` excludes a candidate (`vendor_unhealthy`). `"unknown"`
and `"degraded"` are surfaced on the candidate (`health` field) but do
not exclude it — an operator previewing routing can still see a
never-checked or degraded vendor as the selected candidate, with the
health caveat visible, rather than routing decisions being blocked by
the mere absence of a health check.

### Account Eligibility (Metadata, Not a Selection)

`routing_tiers` references a vendor, never a specific account — Block 11
does not select which account would serve a request (that is an
execution-block concern). Each candidate instead carries an `accounts`
array: every account belonging to the tier's vendor, with its
administrative `status` and its individually observed `health`. The
aggregate `health` field above is computed from this list. **The
existence of an account row is never treated as "executable"** — an
account with `status: "disabled"` or `health: "unknown"` is listed as-is,
never implied to be ready to serve traffic.

## Deterministic Ordering

Candidates are sorted by:

1. **`tier_number` ascending** — the tier structure's own explicit
   ordering (tier 1 before tier 2, etc.).
2. **`priority` descending** — a tie-break within the same `tier_number`.
   Higher priority wins, the same convention `vendors.priority` already
   uses (`AddVendorDrawer`'s "0 = Fallback, 10 = Primary").
3. **Tier `id` ascending** — a final, purely mechanical tie-break when
   `tier_number` and `priority` are both equal. This is never presented
   as a business preference — it exists only so preview output is
   reproducible across repeated calls.

Never used: `Math.random()`, wall-clock time, object/array iteration
order, or database row insertion order. `RoutingService.sortCandidates`
is the one function that defines this order; nothing else re-derives it.

The **selected candidate** is the first eligible candidate in this
order, or `null` if none are eligible.

## Preview / Dry-Run Semantics

`POST /v1/routing/preview` (see `docs/API.md`) answers "what would
Inhouse select?" without doing anything:

- Does not contact a provider.
- Does not execute an LLM request.
- Does not decrypt or read a credential's secret material (the service
  never imports `credentialSecretAccess.ts`).
- Does not create a usage ledger entry.
- Does not create a provider health event.
- Does not perform fallback or retry execution.

It is **configuration simulation only**, read-only against every
dependency it touches (`vendors`, `models`, `workloads`, `capabilities`,
`vendor_accounts`, `vendor_account_health`, `routing_tiers`,
`routing_fallback_rules`).

### Preview Input Is Never Business/Provider-Shaped

`RoutingPreviewInput` (`validation/routing.ts`) accepts exactly three
fields: `workloadId`, an optional `modelId`, and an optional
`capabilityIds` array — all database IDs. There is no field for a
provider name, an outbound header, or a credential. Extra/unrecognized
fields in a request body are simply not read (see
`test/routing.test.ts`, "never accepts provider-shaped fields").

### Outcomes

| `outcome` | Meaning |
|---|---|
| `no_tiers_configured` | The workload has zero `routing_tiers` rows. `candidates` is empty. |
| `no_eligible_candidate` | Tiers exist, but none are eligible. `candidates` lists every tier with its exclusion reasons. |
| `selected` | At least one eligible candidate; `selectedCandidate` is the deterministic winner. |

## Fallback Rules — Read and Validate, Never Execute

Block 11 reads and validates `routing_fallback_rules` (cross-workload
references are rejected — see "Fallback Rule Boundary" below) and
includes them in a preview's explanation (`decision.fallbackRules`, and
per-candidate `outgoingFallbackRules`). It never evaluates a condition to
actually trigger a fallback:

- **Allowed:** "Tier 1 has a fallback rule to Tier 2 on timeout."
- **Not allowed:** "Provider request timed out, therefore execute Tier 2."

The second behavior is a future execution/failover block's job.

### Fallback Rule Boundary

`from_tier_id`/`to_tier_id` must both already belong to the fallback
rule's own `workloadId` — enforced by `RoutingService.getTierOrThrow`,
which 404s if a referenced tier belongs to a different workload. A
self-referencing rule (`fromTierId === toTierId`) is rejected at
validation time, in addition to the database's own `CHECK
(from_tier_id <> to_tier_id)` constraint (migration `0006`, unchanged).

## Retry Configuration — Read Only, Never Executed

Each candidate's `retryPolicy` surfaces the vendor's configured retry
behavior (`timeoutMs`, `maxAttempts`, `retryOnTimeout`,
`retryOnRateLimit`, `retryOn5xx`, `retryOnAuthFailure`,
`retryOnInvalidResponse`) as policy metadata, with the tier's own
`timeout_override_ms`/`max_attempts` taking precedence when set:

- **Allowed:** "Vendor configuration permits up to 3 retries on
  timeout."
- **Not allowed:** "Retry the provider request three times."

Nothing in this block performs a retry.

## Fixed Condition Vocabulary

`routing_fallback_rules.condition_type` is a free-text `TEXT` column at
the database level (migration `0006`, unchanged), but Block 11's
validation layer (`FALLBACK_CONDITION_TYPES`, `validation/routing.ts`)
constrains API writes to a fixed set that deliberately mirrors the
per-condition retry flags Block 06 already added to `vendors`:

```
on_error | on_timeout | on_rate_limit | on_5xx | on_auth_failure | on_invalid_response
```

This keeps the two vocabularies from drifting apart. Nothing evaluates
`condition_type` to trigger behavior — see "Fallback Rules" above.

## API Surface

See `docs/API.md`, "Routing Policy (Block 11)", for the full endpoint
table. Summary:

- `GET /v1/routing/workloads/:workloadId` — combined workload + tiers +
  fallback rules view.
- `GET`/`POST`/`PATCH`/`DELETE` under `/v1/routing/workloads/:workloadId/tiers`
  — tier CRUD (`DELETE` soft-disables, same convention as vendor/model
  deletion).
- `GET`/`POST`/`PATCH`/`DELETE` under
  `/v1/routing/workloads/:workloadId/fallback-rules` — fallback rule CRUD
  (`DELETE` soft-disables).
- `POST /v1/routing/preview` — the dry-run decision described above.

Every write validates that a referenced vendor/model/tier/workload
actually exists and that a tier's vendor/model is actually assigned to
the tier's workload (`vendor_workloads`/`model_workloads`) before
inserting — mirroring `VendorService`/`ModelService`'s existence guards.
No endpoint silently creates a vendor, model, workload, or capability;
those remain managed by their own existing systems.

## Execution Boundary

Explicitly not implemented, not started, in this block:

- Provider execution of any kind — no outbound HTTP call originates from
  `RoutingService` or `routes/routing.ts`.
- Fallback execution — evaluating a `routing_fallback_rules` condition
  against a real failure and acting on it.
- Retry execution — actually retrying a request per a vendor's
  configured retry flags.
- Credential decryption — `RoutingService` never imports
  `credentialSecretAccess.ts`.
- Claude Code / Anthropic Messages compatibility.
- Billing/cost/accounting calculation, or any usage ledger write.
- Customer quota enforcement.
- A public execution endpoint (`/chat/completions`, `/messages`,
  `/generate`, `/execute`) — none exists anywhere in this codebase.

Those remain later blocks:

```
BLOCK 08  Credentials
    |
BLOCK 09  Provider Health
    |
BLOCK 10  Provider Adapters
    |
BLOCK 11  Routing Policy            <- this block
    |
BLOCK 12  Execution Engine
    |
BLOCK 13  Claude Code / API Compatibility
    |
later     Accounting / Usage / Governance
```

## Frontend

The Vendors page already has a read-only "Routing" tab showing a
vendor's own priority/tier/retry configuration (Block 06). Block 11 adds
a dedicated **Routing** page (`frontend/src/pages/Routing.tsx`):
workload selector, tier list (vendor/model/priority/enabled/health),
fallback rule list, and a preview/dry-run action that renders the
candidate list with eligible/excluded state and exclusion reasons, and
the selected candidate. Entirely data-driven — no hardcoded provider
inventory, and an explicit empty state when a workload has no routing
tiers configured yet. The preview result is presented as an explanation,
never labeled as live execution.

## Testing

- `test/routing.test.ts` — validation unit tests for tier/fallback-rule
  create/patch input and preview input, including that preview input
  never carries through unrecognized/provider-shaped fields.
- `test/db/routing.test.ts` — full API-level coverage: tier CRUD
  (existence guards, workload-assignment guards, duplicate-tier
  conflict, cross-workload 404s), fallback-rule CRUD (self-reference and
  cross-workload rejection), and preview (no-tiers, single-candidate
  selection, tier/vendor/model disabled exclusions, requested-model
  filtering, capability enforcement, all three health scenarios,
  deterministic ordering including a true-tie stability check across
  repeated calls, and an explicit assertion that preview never writes a
  usage ledger row or a health event and never mentions a secret/
  credential in its response).

## Security / Hardcoding / Execution Scans (self-audit)

Performed before considering this block complete:

- `grep` for a business-provider inventory introduced by this block's
  new files — none found.
- `grep` for `ProviderAdapter`/`AdapterRegistry`/
  `credentialSecretAccess`/`fetch(` in `routingService.ts`/`routing.ts`
  (routes) — none found; the service has no way to reach a provider.
- `grep` for a usage-ledger or health-event *write* call from the new
  routing files — none found; `test/db/routing.test.ts` additionally
  asserts row counts are unchanged after a preview call.
- `grep` for `Math.random` in the new files — none found; ordering is a
  pure, deterministic sort.
- No execution route (`/chat/completions`, `/messages`, `/generate`,
  `/execute`) added.
- No access to `/root/adorbis-api` from any new file.
