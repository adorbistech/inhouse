# Execution & Claude Integration (Block 12)

The first layer allowed to make real outbound provider requests and to decrypt a provider credential.

## Flow

client → `authenticateApiKey` (`services/apiKeyAuthService.ts`) → request validation (`validation/execution.ts`) → **key → workload authorization** → `RoutingService.preview()` (Block 11, unchanged) → `ExecutionService` → credential via `getDecryptedCredentialSecret()` (Block 08 boundary, the only call site) → `ProviderAdapter.execute()` / `.executeStream()` (Block 10 contract, extended) → normalized result/events → one `usage_ledger` row → protocol formatter (`routes/executionFormatters.ts`).

Routes only translate wire formats; they contain no provider or vendor logic. One provider-neutral model (`ExecutionMessage`, tools, tool calls, finish reasons, stream events) is used end to end.

## Two separate credential classes — never interchangeable

| | Client execution key | Administrative token |
|---|---|---|
| Purpose | call `/v1/chat/completions`, `/v1/messages` | manage keys, read usage |
| Format | `ihk_…` (server generated, stored as SHA-256 hash) | `INHOUSE_ADMIN_TOKEN` env var (≥ 32 chars) |
| Header | `Authorization: Bearer` or `x-api-key` | `Authorization: Bearer` |
| Guard | `services/apiKeyAuthService.ts` | `plugins/adminAuth.ts` |

Neither is a provider credential; a client key cannot authenticate as admin, an admin token cannot execute, and a provider secret authenticates as neither (all covered by tests).

### Administrative authentication
Guards **every control-plane route** — vendors, accounts, credentials, capabilities, workloads, models, routing, provider health, `/v1/api-keys*` and `/v1/usage` — via one shared `requireAdmin` hook (Block 12E). Only `/health`, `/ready` (and their `/v1` twins) and the execution endpoints are outside it. The token comes only from the environment, is compared in constant time over SHA-256 digests, is never logged/returned/stored in the database, and the guard **fails closed**: with no token configured these routes answer 503 `ADMIN_AUTH_NOT_CONFIGURED`. `production`/`staging` refuse to start without it. The API now binds `127.0.0.1` by default (`INHOUSE_API_HOST`); docker-compose sets `0.0.0.0` inside the container only.

> Loopback binding is defense in depth only; the control plane requires the admin token regardless of network position.

## Key → workload authorization (provider-terms safeguard)

A client key can execute **only** workloads explicitly granted to it (`inhouse_api_key_workloads`, migration `0014`). Default deny: no grant, no execution. The check runs first in `ExecutionService` — before routing, credential decryption, any adapter call or ledger write — and a workload that does not exist is indistinguishable from an ungranted one (403 `WORKLOAD_NOT_PERMITTED`). Vendor↔workload assignment (routing) decides what may *serve* a workload; the key grant decides who may *request* it, so a key issued for an application workload can never reach a coding-agent workload merely by naming a different `workloadId`. Everything is data-driven; no provider or workload name is special-cased. INHOUSE does not interpret provider terms — operators must assign vendors to workloads their plan permits and grant keys accordingly. Tests: `test/db/keyWorkloadScoping.test.ts`.

The workload is always explicit: `workloadId` body field (wins) or the `x-inhouse-workload-id` header. It is never inferred from model, prompt, client or endpoint.

## Endpoints

- `POST /v1/chat/completions` — OpenAI-compatible; text, `tools`/`tool_choice`, assistant `tool_calls`, `tool` results, `stream`.
- `POST /v1/messages` — Anthropic-compatible; text blocks, `system`, `tools`/`tool_choice`, `tool_use`/`tool_result` blocks, `stream`. Errors use Anthropic's `{ "type": "error", "error": { "type", "message" }, "request_id" }` envelope.
- Not supported (rejected with 400, never silently dropped): images/documents/thinking blocks, server-side tools, legacy `functions`. Sampling fields not forwarded (`top_p`, `top_k`, `stop`, `stop_sequences`, `metadata`, `thinking`, …) are accepted and ignored.
- `GET /v1/models` is **not** provided for clients: that path is the Block 07 control-plane model catalog. Claude Code's messages flow does not need it.

### Claude Code
```
export ANTHROPIC_BASE_URL=<INHOUSE_API_ORIGIN>          # no /v1 suffix
export ANTHROPIC_AUTH_TOKEN=<INHOUSE_KEY>
export ANTHROPIC_CUSTOM_HEADERS="x-inhouse-workload-id: <WORKLOAD_ID>"
```
The model name Claude Code sends must equal a catalog `inhouse_alias`. Verify `ANTHROPIC_CUSTOM_HEADERS` support against your installed Claude Code version (otherwise the workload cannot be supplied); this has not been exercised against a real Claude Code client in this environment.

## Streaming

`"stream": true` on either endpoint. The adapter contract gained an optional `executeStream()` returning a `ProviderStreamResult`:
- `ok:false` = provider failed **before** any byte — retry and fallback still apply and the client gets an ordinary JSON error.
- `ok:true` = normalized `text_delta` / `tool_call_delta` / `finish` / `error` events. After this point fallback is impossible; a failure becomes a terminal error event (OpenAI: error frame + `[DONE]`; Anthropic: `event: error`).
- Bounded: idle timeout (`timeoutMs`, re-armed per chunk), total byte cap (`MAX_STREAM_BYTES`), absolute duration cap (`MAX_STREAM_DURATION_MS`), SSE parsed incrementally, backpressure via `drain`. Nothing is buffered whole.
- One ledger row is written when the stream ends: complete (provider usage if reported), errored, or abandoned (client disconnect → `cancelled`).
- A protocol whose adapter lacks `executeStream` fails that candidate as `configuration`; nothing is ever faked as a stream.

## Tools

Transported, never executed: definitions, calls (id/name/JSON arguments), results and multi-turn continuation are normalized provider-neutrally and translated by the adapter. Inbound conversations are validated (each tool result must answer an earlier call exactly once; arguments must be JSON).

## Cancellation

Client disconnect → `AbortSignal` → execution service → adapter → outbound request. Checked before every attempt, retry backoff (interruptible), fallback and credential access; a cancelled execution is never retried and never falls back, and is recorded as `cancelled`.

## Retry & fallback

- Per candidate: up to the tier's `retryPolicy.maxAttempts` (else the vendor's `retry_max_attempts`), only for categories the vendor marks retryable, backoff capped at 2 s. Timeout per attempt from tier/vendor config (a code default applies only when neither is configured).
- Fallback requires vendor `automatic_fallback`, a matching enabled `routing_fallback_rules` row, and an eligible, unvisited target tier. A visited set makes loops impossible; work is bounded by tiers × attempts.

## Error categories

`authentication, authorization, rate_limit, timeout, network, provider_error, configuration, invalid_request, model_not_found, unavailable, no_eligible_candidate, cancelled, unknown`. Public errors carry only the category, a short safe message, `requestId` and `executionId`. An adapter that throws is normalized to `unknown` (500) with a generic message.

## Accounting & robustness

One `usage_ledger` row per execution (migration `0013`: `execution_id`, `request_id`, `attempt_count`, `provider_request_id`). Tokens are stored only if the provider reported them, else NULL — never estimated. On the wire, where a number is mandatory (Anthropic `usage`), an unreported figure is rendered as `0`; the ledger keeps NULL.

If the ledger write fails after the provider already answered, the client still receives its result and no database error leaks; a structured `usage_ledger_write_failed` log line carries exactly the fields the row would have held (ids, counts, category — no content, no secrets) for reconciliation. Nothing claims accounting succeeded when it did not.

`x-request-id` is honored only if it matches `^[A-Za-z0-9._:-]{1,128}$`; otherwise a fresh UUID replaces it.

## Known gaps

- **Cost accounting**: no pricing schema exists, so `provider_cost` / `inhouse_cost` stay NULL.
- **Content**: text only; no images/documents/thinking blocks/server tools.
- **Not verified against a real Claude Code / real provider** in this environment (all provider traffic in tests is a local mock).
- No per-key rate limits or quotas.
