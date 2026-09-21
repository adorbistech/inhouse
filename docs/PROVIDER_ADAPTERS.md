# Inhouse Provider Adapter / Integration Layer (Block 10)

This document is the deep-dive on Block 10. `docs/API.md` documents the
HTTP contract change (`adapterSupported`); `docs/PROVIDER_HEALTH.md`
documents the Block 09 health model this block plugs into; this document
explains the provider registry vs. adapter code distinction, the protocol
registry, the adapter interface, and what Block 10 deliberately does not
do.

## Provider Data vs. Adapter Code

These are two different things, and Block 10 keeps them separate on
purpose:

- **Provider data** — a `vendors` row: identity, protocol, endpoint,
  billing, tiering, retry defaults, plus its accounts/credentials/models
  and capability/workload assignments. Entirely database-driven, created
  and managed through the existing Vendor System API (Block 06) and the
  Vendors control-plane page — Block 10 adds no new provider-management
  endpoint or page, because that already exists.
- **Adapter code** — a `ProviderAdapter` implementation
  (`backend/src/services/adapters/`) for one *technical protocol* (e.g.
  `"openai-compatible"`). Code-defined, deployed with the backend, and
  completely unaware of which vendors exist.

**A vendor may exist in the database without a compatible adapter being
available**, and that is a normal, expected state — not an error, not
something the frontend should hide, and not something any endpoint should
paper over by claiming the vendor is executable when it isn't.

## `PROVIDER INVENTORY IS NOT HARDCODED`

Nothing in this codebase contains a business-provider list, in any form:

```
// This does not exist anywhere in this codebase, and never should:
const providers = ["OpenAI", "Anthropic", "Gemini", "z.ai", "Alibaba", "Cerebras"];
```

The database (`vendors`, reused unchanged from Block 06/09 — see
"Provider Registry" below) is the only source of truth for which business
providers are configured. The frontend is the control plane that creates
and edits those rows through the existing Vendor System API. Block 10
adds no seed data, no startup-time vendor creation, and no route that
assumes a fixed set of vendors.

What **is** code-defined, and is explicitly not a violation of this rule,
is the *protocol* registry — a small, fixed map of technical protocol
identifiers to adapter implementations:

```ts
// backend/src/services/adapters/adapterRegistry.ts
registry.register(new OpenAiCompatibleAdapter()); // protocol: "openai-compatible"
```

The difference: `"openai-compatible"` is a technical wire format, not a
business name. Many differently-named vendors in the database can share
it (`Vendor A`, `Vendor B`, `Vendor C` in the example below), and the
registry has no idea any of them exist:

```
Database Provider        Protocol             Adapter
────────────────────────────────────────────────────────
Provider A               openai-compatible    OpenAiCompatibleAdapter
Provider B               openai-compatible    OpenAiCompatibleAdapter
Provider C               custom-protocol      (no adapter registered)
```

`AdapterRegistry.has(protocol)`/`.get(protocol)` returning "not found" for
`Provider C`'s protocol is the expected outcome for a provider whose
protocol has no adapter yet — not a bug.

## Provider Registry: Reused, Not Duplicated

`vendors` (Block 05/06) already represents provider identity, protocol,
and endpoint configuration — `slug`, `display_name`, `vendor_type`,
`protocol`, `base_endpoint`, `status`, plus the Block 06 priority/retry
columns. **Block 10 adds no new table and no new column.** Inspection
before building confirmed the existing schema already carries exactly the
fields the "provider registry" concept in the build brief called for:

- provider/vendor identity → `vendors.slug` / `display_name`
- provider protocol → `vendors.protocol`
- provider endpoint configuration → `vendors.base_endpoint`
- provider account configuration → `vendor_accounts` (Block 05)
- provider capabilities / workload classification → `vendor_capabilities`
  / `vendor_workloads` (Block 06)
- provider models → `models`, scoped by `vendor_id` (Block 07)
- provider credentials → `vendor_credentials` (Block 05/08)
- provider health → `vendor_account_health*` (Block 09)

A second `providers` table, `accounts` table, `models` table, or
`credentials` table would have duplicated all of this for no benefit —
so none was created.

## Protocol Registry / Adapter Registry

`backend/src/services/adapters/adapterRegistry.ts`:

```ts
class AdapterRegistry {
  register(adapter: ProviderAdapter): void;   // throws on a duplicate protocol
  get(protocol: string): ProviderAdapter | undefined;
  has(protocol: string): boolean;
  listSupportedProtocols(): string[];
}

function createDefaultAdapterRegistry(): AdapterRegistry; // registers OpenAiCompatibleAdapter
```

Looked up by `vendors.protocol` — never by vendor id, slug, or display
name. `routes/vendors.ts` constructs one default registry per process
(`registerVendorRoutes`'s `adapterRegistry` parameter, defaulting to
`createDefaultAdapterRegistry()`) and uses it purely to compute the
`adapterSupported` field on every vendor response — see "API Surface"
below. Nothing else in the request path touches it.

## Adapter Interface

`backend/src/services/providerAdapter.ts` (Block 09's file, extended, not
replaced):

```ts
interface ProviderAdapter {
  readonly protocol: string;
  checkHealth(secret: string, config: ProviderAdapterConfig): Promise<ProviderHealthCheckResult>;
  execute(secret: string, config: ProviderAdapterConfig, request: NormalizedProviderRequest): Promise<ProviderExecutionResult>;
}
```

`ProviderAdapterConfig` (`{ baseEndpoint, timeoutMs }`) and the
`NormalizedProviderRequest`/`NormalizedProviderResponse`/
`NormalizedProviderError` types are new in Block 10, additive to Block
09's `ProviderHealthCheckResult`/`ProviderErrorCategory`. `checkHealth`'s
signature gained a `config` parameter (Block 09's version only took
`secret`) — a protocol-generic adapter cannot check a specific vendor's
health without knowing which endpoint to call; nothing implemented the
interface yet, so this was a safe extension, not a breaking one.

### `NormalizedProviderRequest` deliberately excludes routing-shaped fields

```ts
interface NormalizedProviderRequest {
  model: string;              // already-translated provider-facing model id
  messages: NormalizedProviderMessage[];
  maxOutputTokens: number | null;
  temperature: number | null;
  stream: boolean;
}
```

No `vendorAccountId`, no priority, no fallback list, no pricing, no
quota. An adapter only ever receives "translate and send this" — it never
sees enough to make a routing or business decision, because it isn't
supposed to be able to (see "No Routing" below).

### Concrete Adapter: `OpenAiCompatibleAdapter`

`backend/src/services/adapters/openAiCompatibleAdapter.ts` implements the
`"openai-compatible"` protocol: standard `GET {baseEndpoint}/models`
(health) and `POST {baseEndpoint}/chat/completions` (execute), Bearer
authentication. Nothing about `api.openai.com`, OpenAI's business rules,
or OpenAI pricing is in this file — `baseEndpoint` and the credential are
always caller-supplied, so any number of differently-configured vendors
can share this one adapter (see the table above).

Its HTTP transport is injectable (`FetchLike`, defaulting to the platform
global `fetch`) purely so tests can exercise real timeout/JSON-parsing/
error-mapping behavior against a deterministic stub — production code
always uses the default.

### Why Not a Deterministic Test-Only Adapter in `src/`

The build brief allows building "deterministic test adapters" when a
protocol can't yet be safely implemented. Here, the one protocol the
existing architecture actually needs (`"openai-compatible"`, already
present as a `vendors.protocol` value in fixtures/tests going back to
Block 06) could be implemented safely and completely, so it was — a
placeholder adapter alongside a real one would have been speculative
scaffolding with no purpose. The registry-mechanics tests
(`test/adapterRegistry.test.ts`) still use a minimal in-memory stub
adapter, but it lives in the test file only, never in `src/`.

## Credential Boundary

Adapters never touch `secret_ciphertext`/`secret_iv`/`secret_auth_tag` or
`INHOUSE_CREDENTIAL_ENCRYPTION_KEY`. Every `checkHealth`/`execute` call
receives an already-decrypted `secret: string`, obtained by the caller
through Block 08's existing, unchanged
`services/credentialSecretAccess.ts#getDecryptedCredentialSecret` — the
one function in this codebase allowed to return a decrypted secret. A
disabled credential still cannot be decrypted (Block 08's guarantee,
untouched); see `test/db/adapterHealthIntegration.test.ts`'s "disabling a
credential makes it unusable for a health check" test.

The adapter itself never persists, logs, or echoes the secret anywhere —
every adapter test (`test/support/providerAdapterContract.ts`) asserts
the secret never appears in a normalized error, a safe error code, or the
outbound request body's serialized form (only the `Authorization` header
carries it, which the transport stub captures separately from the body).

## HTTP Transport

Every outbound call `OpenAiCompatibleAdapter` makes:

- has an explicit timeout (`AbortController` + `setTimeout(..., config.timeoutMs)`), sourced from the vendor's own `timeoutMs`/a caller-supplied value — never hardcoded and never indefinite;
- bounds the outbound request body (`MAX_REQUEST_BODY_BYTES`, `httpErrorMapping.ts`) — an oversized request is rejected as `invalid_request` before any network call is made;
- bounds the inbound response body it will read (`MAX_RESPONSE_BODY_BYTES`, `readBoundedResponseText` in `httpErrorMapping.ts`) — the response is streamed and counted, not buffered via `res.json()`/`res.text()` first and measured after, so a misbehaving or oversized provider response (regardless of what its `Content-Length` claims, or whether one is present at all) is never fully read into memory; exceeding the bound is treated as a normalized `provider_error`, never a crash;
- constructs exactly two outbound headers itself (`Authorization`, `Content-Type`) and never forwards any inbound header from a caller — there is no caller-header parameter on `execute()`/`checkHealth()` for one to forward;
- never logs a request body, an authorization header, or a secret (no logging statements exist in this adapter at all).

## Response Normalization

`NormalizedProviderResponse` — `providerRequestId`, `model`, `output`,
`finishReason`, `usage`, `latencyMs`. Never the raw provider JSON, and no
billing/cost calculation is derived from it (that's a later, dedicated
accounting block's job — see "What Block 10 Does Not Implement").

## Error Normalization

`NormalizedProviderError.category` is one of:
`authentication | authorization | invalid_request | model_not_found |
rate_limit | timeout | network | provider_error | unavailable |
configuration | unknown` — the broader, execution-shaped superset of
Block 09's narrower health-check category set (`ProviderErrorCategory`,
unchanged, still the only categories a *health* observation can carry —
see `validation/providerHealth.ts`). `message` is always a short,
technical, safe string; the raw provider response body is never included
anywhere in a `NormalizedProviderError`.

## Health Integration

Unchanged Block 09 pieces: `ProviderHealthService.recordObservation()`
persists; `GET .../health` and `.../health/events` are still the only
read surface, still read-only. Block 10 adds the first real
`checkHealth()` implementation (`OpenAiCompatibleAdapter`), so the
previously-abstract seam is now provably real —
`test/db/adapterHealthIntegration.test.ts` wires
`getDecryptedCredentialSecret` → `adapter.checkHealth()` →
`ProviderHealthService.recordObservation()` end-to-end against a local,
disposable mock HTTP server (never a real provider), covering a
successful check, an authentication failure, and a real timeout bounded
by the vendor's configured `timeoutMs`.

**One route calls this flow (Block 14A).** The authenticated
`POST /v1/vendors/:id/accounts/:accountId/verify` action
(`services/providerVerificationService.ts`) composes the same steps —
credential access, `adapter.checkHealth()` once, `recordObservation()` —
on demand for an administrator. Normal request execution and routing do
not use this flow. No scheduled/periodic health check exists yet; that
remains a later block's job.

## Model Catalog

Unchanged. An adapter's `NormalizedProviderRequest.model` is the
provider-facing model identifier; translating a Block 07 `models` row's
Inhouse alias to that identifier is the caller's job (a future execution
block), not the adapter's — Block 10 does not duplicate or extend the
model catalog.

## No Routing

`ProviderAdapter` methods never decide which vendor, account, or model to
use, and never see a priority or fallback list — they receive an
already-selected `config`/`secret`/`request` and do exactly what they're
told. This is enforced by the interface's shape, not just convention:
there is no field on `NormalizedProviderRequest` an adapter could use to
make that decision even if it wanted to.

## No Execution API

There is no `/chat/completions`, `/messages`, `/generate`, or `/execute`
route anywhere in this codebase. `execute()` is an internal primitive,
callable only from within the backend process (today, only from tests) —
a later, dedicated execution block will expose a controlled boundary over
it. (Historical, Block 10: the frontend's "Test Connection" button was
disabled at that point. It was removed in Block 14B-2; the single
operational action is now "Verify Account", which calls the Block 14A
verify endpoint.)

## No Claude Code Integration

Not implemented, not started: no Claude Code API compatibility, no
Anthropic Messages gateway, no Claude Code authentication or model
translation. A later, dedicated integration block.

## API Surface: `adapterSupported`

The only HTTP-visible change in Block 10. Every vendor response (`GET
/v1/vendors`, `GET /v1/vendors/:id`, and the body of every vendor
create/update/status-change response) now includes:

```json
{ "adapterSupported": true }
```

Computed at serialization time (`routes/serializers.ts`'s
`toVendorResponse`/`toVendorDetailResponse`, now parameterized) from
`AdapterRegistry.has(vendor.protocol)` — **never** stored on the `vendors`
row, never returned by a repository query, and never influenced by the
vendor's own `status`. A `disabled` vendor whose protocol has an adapter
still reports `adapterSupported: true` — adapter support is a fact about
the protocol, not about whether an operator currently wants the vendor
used.

The Vendors page (`frontend/src/pages/Vendors.tsx`) renders this as an
"Adapter Ready" / "No Adapter" chip on every vendor card and an "Adapter
Support" tile in the inspector's Overview tab — visually distinct from
the vendor's own enabled/disabled status pill, so "this provider is
configured" is never presented as "this provider is executable."

## Testing

- `test/adapterRegistry.test.ts` — registration, lookup, duplicate-protocol
  rejection, unsupported-protocol lookup, and multiple synthetic "vendors"
  (protocol strings) sharing one adapter instance.
- `test/openAiCompatibleAdapter.test.ts` — protocol-specific behavior
  (URL construction, header construction, wire-format translation,
  request and response size bounds) plus the full reusable contract suite.
- `test/support/providerAdapterContract.ts` — the reusable adapter
  contract suite (request translation, response normalization, error
  normalization for every HTTP status this block maps, malformed-JSON
  handling, network failure, timeout/abort, and secret non-leakage across
  every failure mode) any future protocol adapter is expected to run
  through its own thin test file, rather than re-deriving these assertions
  by hand.
- `test/db/vendors.test.ts` — `adapterSupported` is `false` for a
  configured protocol with no adapter and `true` for one that has one,
  independent of the vendor's own status; never persisted on the row.
- `test/db/adapterHealthIntegration.test.ts` — the full credential →
  adapter → health-service composition against a local mock HTTP server:
  a successful check, an authentication failure (never leaking the raw
  provider body or the secret), a real bounded timeout, and a disabled
  credential correctly refusing to decrypt.

**No automated test makes a real call to any real provider or requires
real provider credentials** — every adapter test uses either an injected
`FetchLike` stub or a local, disposable `node:http` server bound to
`127.0.0.1`.

## Security / Hardcoding / Routing Scans (self-audit)

Performed before considering this block complete:

- `grep`-shaped search for a business-provider inventory (`providers =`,
  `PROVIDERS =`, a business-name-keyed map) across `backend/src` — none
  found. The only registry is `AdapterRegistry`, keyed by protocol string.
- Search for `routing`/`fallback`/`failover`/`pricing`/`quota` introduced
  by this block's new files — none found; every existing occurrence
  predates Block 10 and lives in already-locked Block 06/10-adjacent
  routing-*configuration* columns/tables, not new logic.
- Search for a hardcoded provider endpoint (`api.openai.com` or similar)
  in adapter code — none; `baseEndpoint` is always `config`-supplied.
- Every outbound network call introduced by this block is inside
  `OpenAiCompatibleAdapter`, configured entirely through
  `ProviderAdapterConfig` (database-sourced) and a caller-supplied
  decrypted secret, timeout-bounded, normalized, and covered by tests. No
  outbound call originates from a route, the frontend, a generic service,
  or a repository.

## What Block 10 Does *Not* Implement

- A public execution endpoint of any kind, or any wiring from an HTTP
  route to `execute()`/`checkHealth()`.
- Routing, model/vendor/account selection, priority, fallback, failover,
  or load balancing.
- Claude Code compatibility or an Anthropic Messages gateway.
- Usage/cost/billing calculation, quota enforcement, or a usage ledger
  write — `NormalizedProviderResponse.usage` is exactly what the provider
  reported, untransformed.
- Any change to `vendors`, `vendor_accounts`, `vendor_credentials`,
  `models`, `vendor_account_health*`, or any other Block 05–09 table —
  Block 10 introduces zero schema migrations.
- A second, real provider adapter for any other protocol — only
  `"openai-compatible"` is implemented; a vendor configured with any other
  protocol (e.g. `"custom_rest"`, unchanged from earlier blocks' test
  fixtures) correctly reports `adapterSupported: false`.
- Any real, periodic, or on-demand invocation of `checkHealth()` from a
  running process — only tests call it.


## Block 12 contract additions

`ProviderAdapter.execute()` now accepts an optional `AbortSignal`; requests/responses carry provider-neutral tools, tool calls and a normalized `finishReason`; `cancelled` is a new execution error category; and an optional `executeStream()` returns a bounded, normalized event stream (`text_delta`, `tool_call_delta`, `finish`, `error`). Implementations must enforce an idle timeout, a total byte cap and an absolute duration cap, and stop work on abort. See [EXECUTION.md](EXECUTION.md).
