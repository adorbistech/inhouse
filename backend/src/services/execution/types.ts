import type {
  NormalizedFinishReason,
  NormalizedProviderMessage,
  NormalizedProviderUsage,
  NormalizedStreamEvent,
  NormalizedToolCall,
  NormalizedToolChoice,
  NormalizedToolDefinition,
} from "../providerAdapter.js";

/**
 * The normalized internal contract `services/executionService.ts` accepts
 * and returns. Deliberately provider-agnostic (see `providerAdapter.ts`'s
 * own doc comment): `routes/execution.ts`'s OpenAI-compatible and
 * Anthropic-compatible handlers each translate their wire format into
 * this shape and back — no provider-specific logic belongs in a route,
 * and no client-protocol-specific logic belongs here or in an adapter.
 */

export type ExecutionRole = "system" | "user" | "assistant" | "tool";

/** The same provider-neutral message model adapters consume — one representation end to end. */
export type ExecutionMessage = NormalizedProviderMessage;

/** What a caller (a public execution route) hands to `ExecutionService.execute()`. */
export interface ExecutionRequest {
  workloadId: string;
  /** The client-facing `models.inhouse_alias` — never a provider model id. */
  modelAlias: string;
  messages: ExecutionMessage[];
  maxOutputTokens: number | null;
  temperature: number | null;
  tools?: NormalizedToolDefinition[];
  toolChoice?: NormalizedToolChoice | null;
}

/** Per-call context that is not part of the request itself. */
export interface ExecutionContext {
  requestId: string;
  /** Aborts outbound provider work (client disconnect). Checked between attempts/retries/fallbacks and passed to the adapter. */
  signal?: AbortSignal;
  /** Structured logger (never given secrets, prompts or completions). */
  log?: { error: (obj: Record<string, unknown>, msg: string) => void };
}

/**
 * A fixed, technical vocabulary — the strict union of every category an
 * adapter can report (`ProviderExecutionErrorCategory`) plus the handful
 * of failure modes that only make sense one layer up, before or around an
 * adapter call: no eligible routing candidate at all, or a genuinely
 * unclassifiable failure. Never a provider name, never a raw error
 * message from a provider.
 */
export type ExecutionErrorCategory =
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "timeout"
  | "network"
  | "provider_error"
  | "configuration"
  | "invalid_request"
  | "model_not_found"
  | "unavailable"
  | "no_eligible_candidate"
  /** The caller aborted — never retried, never a fallback trigger. */
  | "cancelled"
  | "unknown";

/** One provider-adapter call — whether it belongs to the primary tier or a fallback tier, and whether it was a retry. */
export interface ExecutionAttemptRecord {
  attemptNumber: number;
  tierId: string;
  tierNumber: number;
  vendorId: string;
  vendorSlug: string;
  vendorAccountId: string | null;
  modelId: string;
  isFallback: boolean;
  ok: boolean;
  errorCategory: ExecutionErrorCategory | null;
  safeErrorCode: string | null;
  latencyMs: number | null;
}

export interface ExecutionSuccess {
  ok: true;
  executionId: string;
  requestId: string;
  output: string;
  toolCalls: NormalizedToolCall[];
  finishReason: NormalizedFinishReason | null;
  model: { id: string; inhouseAlias: string; providerModelId: string };
  usage: NormalizedProviderUsage;
  isFallback: boolean;
  attempts: ExecutionAttemptRecord[];
  providerRequestId: string | null;
}

export interface ExecutionFailure {
  ok: false;
  executionId: string;
  requestId: string;
  category: ExecutionErrorCategory;
  /** Short and safe — never a raw provider response body or credential material. */
  message: string;
  attempts: ExecutionAttemptRecord[];
}

export type ExecutionOutcome = ExecutionSuccess | ExecutionFailure;

/**
 * A streaming execution that has been *opened* (a provider accepted the
 * request and produced a stream). Everything after this point arrives as
 * `events`; the terminal event is always `finish` or `error`, and exactly
 * one `usage_ledger` row is written when the stream ends — completed,
 * failed, or abandoned by the client.
 */
export interface ExecutionStreamSuccess {
  ok: true;
  executionId: string;
  requestId: string;
  model: { id: string; inhouseAlias: string; providerModelId: string };
  isFallback: boolean;
  events: AsyncIterable<NormalizedStreamEvent>;
}

export type ExecutionStreamOutcome = ExecutionStreamSuccess | ExecutionFailure;
