# Inhouse Coding API — Beta Acceptance Contract

**Status: LOCKED contract. The software is NOT certified by this document.**
This document defines what Beta must prove and how it is certified. It adds
no features and changes no application behavior. Scope changes require an
explicit, recorded decision that amends this file.

## 1. Purpose

Beta proves that one chain works end to end on the Inhouse VPS, isolated
from existing Adorbis systems:

client authentication → workload authorization → model/vendor routing →
account eligibility → credential handling → provider adapter → real provider
execution → retry/fallback → usage ledger → response.

It is proven for two developer clients (Claude Code, Claude Desktop
Developer Mode) and at least one controlled real provider. Beta is not a
commercial or public internet service.

## 2. Scope

In scope: the client execution endpoints (`POST /v1/chat/completions`,
`POST /v1/messages`), client-key authentication and workload scoping,
routing, execution (retry, fallback, streaming, tools transport,
cancellation), account readiness/verification/health, the vault-managed
credential boundary, the usage ledger, the admin control plane (API and
existing UI), loopback Docker deployment, and the mock-provider E2E as the
regression baseline.

Out of scope: see section 11.

## 3. Supported Clients

| Client | Status | Basis |
|---|---|---|
| Claude Code | **Certification required** (Phase 4) | Messages wire format, `x-api-key`/Bearer auth, streaming, tools and the Anthropic error envelope are code-verified; the path through the frontend proxy is HTTP-contract-verified against the mock. The real installed client has **not** been run. |
| Claude Desktop Developer Mode | **Certification required** (Phase 5) — external client dependency | No repository evidence describes its behavior. No requirement is assumed. |

### Claude Code contract under test
- `ANTHROPIC_BASE_URL=<INHOUSE_API_ORIGIN>` (no `/v1` suffix)
- `ANTHROPIC_AUTH_TOKEN=<ihk_… client key>`
- `ANTHROPIC_CUSTOM_HEADERS="x-inhouse-workload-id: <WORKLOAD_ID>"`
- The requested model name equals a catalog `inhouse_alias`.
- Unary, streaming, tool use with `tool_result` continuation, cancellation,
  provider error, fallback and ledger correctness.
- Record whether the client probes `GET /v1/models` (currently an admin
  control-plane route; a client key gets 401). It is required only if
  real-client testing proves it is.

**If `ANTHROPIC_CUSTOM_HEADERS` is unsupported by the installed Claude Code,
STOP.** Record it as a certification finding requiring a separate
architecture decision. The workload-header design is not to be changed
before or during testing.

### Claude Desktop Developer Mode contract
Do not invent protocol requirements. Observe and record the real client's
endpoints, authentication, workload mechanism, streaming, tools, errors and
model behavior. Implementation requirements are derived only from observed
behavior. If Desktop cannot operate with the current contract, Beta cannot
be signed off as fully compatible until the issue is explicitly resolved or
the product scope is formally changed.

## 4. Provider Requirements

At least **one controlled real provider** must complete the chain. "Real
provider ready" means all of:

- Its protocol is served by the registered OpenAI-compatible adapter
  (`openai-compatible`). No Anthropic upstream adapter is added for Beta.
- The vendor is `enabled`, has a `base_endpoint`, and is assigned to the
  workload.
- The model has an `inhouse_alias` and `provider_model_id`, is enabled, and
  is assigned to the workload.
- A routing tier for the workload points at that vendor/model.
- The vendor account is `enabled` with an **INHOUSE vault-managed**
  credential (an external `secretRef` cannot be used for execution or
  verification).
- Verification (`POST /v1/vendors/:id/accounts/:accountId/verify`) has run.
- A unary and a streamed execution succeed with a correct ledger row.
- The secret never appears in any response, log, ledger row or audit event.

The exact provider is chosen at certification time through the existing
data-driven vendor/account/model configuration. Certification requires a
controlled account, written spend approval and a spend cap.

## 5. Authentication

- **Admin:** `INHOUSE_ADMIN_TOKEN` (32+ characters), constant-time compare,
  fails closed (503) when unset. Guards every control-plane route; only
  `/health`, `/ready` and the execution endpoints are outside it.
- **Client key:** server-generated `ihk_…`, stored as a SHA-256 hash; sent as
  `Authorization: Bearer` or `x-api-key`. Revoked, disabled or expired keys
  are rejected with a uniform 401.
- **Workload authorization:** default deny. A key may execute only workloads
  explicitly granted to it; the check runs before routing, decrypt, any
  adapter call or ledger write. The workload is always explicit
  (`workloadId` body field or `x-inhouse-workload-id` header).
- **Isolation:** the admin token, client keys and provider credentials are
  three separate credential classes and are never interchangeable.

### Client key provisioning (API only)
`POST /v1/api-keys` (admin-authenticated) with a name, optional `expiresAt`
and `workloadIds`. The raw key is returned **once**. Grants are changed with
`PUT /v1/api-keys/:id/workloads`; a key is revoked with
`DELETE /v1/api-keys/:id`. No UI is required for Beta.

## 6. Workload Provisioning (administrative SQL procedure)

> **WARNING — read before use.**
> - Raw SQL is an **administrative Beta procedure**. It is **not** a public
>   API, there is no workload-create endpoint, and none is planned for Beta.
> - A workload defaults to `status = 'inactive'`. An inactive workload is
>   **not executable**: routing excludes it (`workload_inactive`). It **must**
>   be set to `enabled`.
> - Creating the row is not enough. The vendor assignment, model assignment
>   and at least one enabled routing tier **must** also exist, or every
>   request fails with `no_eligible_candidate`.
> - Run it only as an operator on the VPS, against the Inhouse database
>   only. Never against any Adorbis database.

### Step 1 — create the workload (enabled)
Use the Inhouse Postgres container (`inhouse-postgres`, database
`inhouse`, schema `inhouse`). Choose a unique, stable `slug`.

```bash
docker exec -i inhouse-postgres psql -U inhouse_app -d inhouse -At -c \
  "INSERT INTO inhouse.workloads (slug, display_name, description, status)
   VALUES ('<slug>', '<Display Name>', '<description>', 'enabled')
   RETURNING id"
```

The returned UUID is the workload id. `slug` is `UNIQUE`; a duplicate fails
rather than overwriting. Do not edit or delete existing rows by hand.

### Step 2 — assign vendor, model and routing (existing admin API)
Use the admin token; every id below is a UUID.

1. `PUT /v1/vendors/:vendorId/workloads` with `{ "workloadIds": [<id>, …] }`
   (this **replaces** the vendor's full set — include any existing ids).
2. `PUT /v1/models/:modelId/workloads` with `{ "workloadIds": [<id>, …] }`
   (also a full replacement).
3. `POST /v1/routing/workloads/:workloadId/tiers` with
   `{ vendorId, modelId, tierNumber, priority, enabled: true }`.
4. Optionally add fallback rules under
   `/v1/routing/workloads/:workloadId/fallback-rules`.

### Step 3 — verify the workload is executable
1. `GET /v1/routing/workloads/:workloadId` — the workload shows
   `status: enabled` and the expected tiers.
2. `POST /v1/routing/preview` with `{ "workloadId": <id>, "modelId": <id> }`
   — `selectedCandidate` is non-null and `eligible` (no `workload_inactive`,
   `vendor_workload_mismatch` or `model_workload_mismatch` reasons). Preview
   never calls a provider and never decrypts a credential.
3. `GET /v1/vendors/:vendorId/accounts/:accountId/readiness` — `ready`.
4. Create a client key granted this workload (section 5) and send one
   execution request; confirm a `usage_ledger` row through `GET /v1/usage`.

This procedure must be exercised during certification (Phases 3, 4 and 6).

## 7. Execution Contract

- **Unary:** OpenAI-compatible and Anthropic-compatible shapes work.
- **Streaming:** SSE, incrementally parsed, bounded by idle timeout, byte cap
  and duration cap. A failure before the stream opens allows retry and
  fallback; after it opens, a failure is a terminal error event and fallback
  is impossible.
- **Tools:** transported, never executed; multi-turn continuation supported.
- **Cancellation:** client disconnect aborts outbound provider work; a
  cancelled execution is never retried or fallen back, and is ledgered as
  `cancelled`.
- **Errors:** category, safe message, `requestId`, `executionId` only. No
  secret or internal detail. Anthropic requests use the Anthropic error
  envelope.
- **Retry:** per tier policy and vendor retryable-category flags, bounded
  backoff.
- **Fallback:** requires vendor `automatic_fallback`, a matching enabled
  rule and an eligible, unvisited target tier. Cycles are impossible.
- **Order:** workload grant → routing → vendor/model/adapter → account and
  credential selection → decrypt → provider. An unsupported adapter fails
  before any decrypt.
- **Request IDs:** a safe caller `x-request-id` is honored, otherwise a UUID
  is generated; it is echoed and stored in the ledger.

## 8. Accounting Contract

Persisted for Beta: **one `usage_ledger` row per logical execution** with
`execution_id`, `request_id`, key, workload, model, vendor, account, primary
and fallback tier, `is_fallback`, `attempt_count`, status,
`error_category`, `provider_request_id`, latency, and provider-reported
tokens (NULL when the provider does not report them — never estimated).
A ledger write failure must not fail the client response and must emit a
structured `usage_ledger_write_failed` log line.

Accepted for Beta: `attempt_count` instead of per-attempt rows; NULL cost
columns. Not required: pricing, provider cost, margin, per-attempt
persistence.

## 9. Security Contract

- Admin/client credential separation and workload isolation hold.
- Provider secrets are decrypted only by the approved callers
  (`executionService.ts`, `providerVerificationService.ts`), enforced by the
  boundary test in `backend/test/db/controlPlaneAuth.test.ts`.
- A disabled credential cannot be decrypted; an external `secretRef` is
  never decrypted.
- Revoked and expired client keys are rejected.
- No secret appears in HTTP responses, errors, logs, ledger rows, audit
  events or frontend state.
- Deployment stays loopback-only.
- Secret scans are performed during real-provider certification.

## 10. Deployment Contract

Beta is an **INTERNAL VPS CERTIFICATION.**

- Frontend and API stay bound to `127.0.0.1`; PostgreSQL is not published.
- No public DNS and no public TLS are required.
- Controlled access uses local VPS access or a controlled tunnel.
- Public exposure is outside Beta. If it is ever intended, this section and
  section 11 must be reopened and the affected items become requirements.
- Existing Adorbis systems are never modified.

## 11. Explicit Non-Requirements

Not prerequisites for Beta sign-off:

- public DNS, public TLS
- rate limits, quotas
- health TTL / automatic re-verification
- pricing, cost accounting
- per-attempt ledger persistence
- workload management API or UI
- API-key management UI
- client-facing `/v1/models` (unless real-client testing proves it required)
- images, documents, thinking blocks, server-side tools
- an Anthropic upstream adapter
- same-tier second-account failover
- egress restrictions on `base_endpoint` (admin-only input; production
  hardening)

Accepted existing behavior: readiness precedence is disabled, unsupported,
missing credential, unverified, unhealthy, ready; `degraded` maps to ready;
unhealthy accounts remain executable (Block 14C/14D design).

## 12. Certification Phases

No phase modifies production application behavior. Each records its
evidence.

### PHASE 1 — Static / Architecture Certification
- **Purpose:** confirm code and docs match this contract.
- **Preconditions:** locked HEAD, clean worktree.
- **Tests:** enumerate decrypt callers; confirm every control-plane route is
  admin-guarded; confirm docs/code agree.
- **Pass:** exactly two decrypt callers; no unguarded control-plane route; no
  doc/code contradiction.
- **Evidence:** grep output, route inventory.

### PHASE 2 — Automated Regression Certification
- **Purpose:** confirm the locked baseline is green.
- **Preconditions:** disposable test DB via `npm run test:db`.
- **Tests:** backend unit, `test:db`, frontend tests, typecheck, lint, build.
- **Pass:** no failures; counts at or above the 14D baseline (169 backend
  unit, 230 DB/API, 119 frontend).
- **Evidence:** full runner output.

### PHASE 3 — Deployment Certification
- **Purpose:** confirm the runtime is stable and contained.
- **Preconditions:** compose stack up; workload procedure (section 6) used to
  provision at least one workload.
- **Tests:** mock E2E (`e2e/run-e2e.mjs`) through the frontend proxy; restart
  persistence; health checks; loopback-only ports; disk/`/tmp` before/after.
- **Pass:** all E2E checks pass; ports loopback-only; no unexpected disk
  growth.
- **Evidence:** E2E output, `ss -tln`, `docker ps`, `du` before/after.

### PHASE 4 — Claude Code Real Client Certification
- **Purpose:** prove the real installed client works through Inhouse.
- **Preconditions:** client key with workload grant; enabled, routed
  workload; Claude Code version recorded.
- **Tests:** section 3 contract — unary, streaming, tools, cancellation,
  provider error, fallback, ledger; record `/v1/models` probing and
  `ANTHROPIC_CUSTOM_HEADERS` behavior.
- **Pass:** all scenarios complete with correct ledger rows; cancellation is
  ledgered `cancelled`.
- **Evidence:** client version, sanitized logs, ledger rows. An unsupported
  `ANTHROPIC_CUSTOM_HEADERS` stops the phase (section 3).

### PHASE 5 — Claude Desktop Developer Mode Certification
- **Purpose:** establish and verify what the real client needs.
- **Preconditions:** access to the client and its documented configuration.
- **Tests:** observe endpoints, auth, workload mechanism, streaming, tools,
  errors, model behavior; run the Phase 4 scenarios.
- **Pass:** scenarios complete under the current contract, or the
  incompatibility is recorded and explicitly resolved or scoped out by a
  formal decision.
- **Evidence:** observed requests and outcomes.

### PHASE 6 — Controlled Real Provider Certification
- **Purpose:** prove the chain against a real upstream.
- **Preconditions:** controlled account; written spend approval and cap;
  vault-managed credential; OpenAI-compatible endpoint.
- **Tests:** verification; unary execution; streaming execution; ledger
  verification (tokens match provider-reported); secret scan of responses,
  logs, ledger and audit events.
- **Pass:** verification recorded; both executions succeed; ledger correct;
  scans clean.
- **Evidence:** verification result, ledger rows, scan output.

### PHASE 7 — Security / Isolation Certification
- **Purpose:** confirm boundaries with real data.
- **Preconditions:** two workloads and two keys with different grants.
- **Tests:** cross-workload request → 403; client key on admin route → 401;
  admin token on execution route → 401; revoked and expired keys rejected;
  disabled credential not decrypted; secret scans.
- **Pass:** every negative case rejected; scans clean.
- **Evidence:** request/response transcripts, scan output.

### PHASE 8 — Final Beta Sign-Off
- **Purpose:** the formal lock.
- **Preconditions:** Phases 1–7 complete.
- **Tests:** review all evidence against sections 3–11.
- **Pass:** section 13 satisfied.
- **Evidence:** a sign-off record naming the commit hash.

## 13. Final Sign-Off Criteria

Beta can be signed off only when **all** hold:

- all required automated tests pass
- deployment E2E passes
- real Claude Code certification passes
- Claude Desktop Developer Mode certification passes
- at least one controlled real provider passes
- ledger verification passes
- secret scans pass
- workload isolation passes
- no required contract item remains unresolved
- all deferred items (section 11) are explicitly recorded
