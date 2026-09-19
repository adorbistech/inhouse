/**
 * The shape a provider adapter implements to perform real, network-calling
 * work against a vendor's API: a health check (Block 09) and a request
 * execution primitive (Block 10). Everything here is protocol-shaped, never
 * business-provider-shaped — there is no `if (vendorType === "...")`
 * anywhere in this file, its implementations, or its callers. A concrete
 * adapter (e.g. `adapters/openAiCompatibleAdapter.ts`) implements this
 * interface for one *technical protocol*; which business vendors use that
 * protocol is a database fact (`vendors.protocol`), never hardcoded here.
 *
 * Nothing in this codebase calls `execute()` from a route, and there is no
 * public execution endpoint — see docs/PROVIDER_ADAPTERS.md. Wiring this
 * into an actual request/response path (routing, model selection, usage
 * accounting) is explicitly a later block's job.
 */

export type ProviderHealthStatus = "healthy" | "degraded" | "unhealthy";

/**
 * Technical, provider-agnostic failure classifications — not provider
 * names or provider-specific error codes. An adapter is responsible for
 * mapping whatever a provider actually returns onto this fixed set. This
 * is deliberately the same fixed set `validation/providerHealth.ts`
 * (`ERROR_CATEGORIES`) accepts for a stored health observation — a health
 * check's error can only ever be one of these, by construction.
 */
export type ProviderErrorCategory =
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "timeout"
  | "network"
  | "provider_error"
  | "configuration"
  | "unknown";

/**
 * A request-execution failure can additionally be one of these — categories
 * that only make sense for a real generation request (an invalid body, an
 * unknown model id, a provider that is temporarily down), not for the
 * minimal call a health check makes. Kept as a strict superset of
 * `ProviderErrorCategory` rather than a separate enum so the two vocabularies
 * never drift apart for the categories they do share.
 */
export type ProviderExecutionErrorCategory =
  | ProviderErrorCategory
  | "invalid_request"
  | "model_not_found"
  | "unavailable";

export interface ProviderHealthCheckResult {
  status: ProviderHealthStatus;
  /** Round-trip latency of the check itself, in milliseconds. */
  latencyMs: number | null;
  /** Present only when `status !== "healthy"`. */
  errorCategory: ProviderErrorCategory | null;
  /**
   * A short, technical, non-sensitive code (e.g. an HTTP status or a
   * network errno-style string) — never a full provider response body,
   * which could contain request/credential/prompt data.
   */
  safeErrorCode: string | null;
}

/**
 * Everything a protocol adapter needs to reach a *specific configured*
 * vendor/account — sourced entirely from database configuration (`vendors`),
 * never hardcoded. Deliberately excludes anything routing- or
 * business-shaped: no priority, no fallback list, no pricing, no quota.
 */
export interface ProviderAdapterConfig {
  /** `vendors.base_endpoint` — never a business endpoint baked into adapter code. */
  baseEndpoint: string;
  /** Bounds every outbound call this adapter makes — no indefinite request. */
  timeoutMs: number;
}

export interface NormalizedProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * What a caller hands an adapter to execute. Intentionally excludes
 * anything that would let an adapter make a routing or business decision
 * (no vendor/account id, no priority, no fallback list, no pricing) — the
 * adapter only ever sees "translate and send this," never "choose where to
 * send it." See docs/PROVIDER_ADAPTERS.md, "No Routing".
 */
export interface NormalizedProviderRequest {
  /** The provider-facing model identifier (already translated from an Inhouse alias by the caller). */
  model: string;
  messages: NormalizedProviderMessage[];
  maxOutputTokens: number | null;
  temperature: number | null;
  stream: boolean;
}

export interface NormalizedProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

/**
 * An adapter's successful, normalized result — never the raw provider JSON.
 * No billing/cost calculation belongs here; `usage` is exactly what the
 * provider reported, untransformed.
 */
export interface NormalizedProviderResponse {
  providerRequestId: string | null;
  model: string;
  output: string;
  finishReason: string | null;
  usage: NormalizedProviderUsage;
  latencyMs: number;
}

/**
 * Never a raw provider response body, an authorization header, or request
 * content — `message` is a short, safe, technical description an operator
 * can read without it becoming an exfiltration path for a prompt or a
 * secret.
 */
export interface NormalizedProviderError {
  category: ProviderExecutionErrorCategory;
  safeErrorCode: string | null;
  message: string;
}

export type ProviderExecutionResult =
  | { ok: true; response: NormalizedProviderResponse }
  | { ok: false; error: NormalizedProviderError };

/**
 * One implementation per *technical protocol* (e.g. "openai-compatible"),
 * looked up via `adapters/adapterRegistry.ts` by `vendors.protocol` — never
 * one implementation per business vendor. A vendor whose `protocol` has no
 * registered adapter simply has no `ProviderAdapter` to look up; that is
 * an expected, normal state (see docs/PROVIDER_ADAPTERS.md), not an error.
 */
export interface ProviderAdapter {
  /** The technical protocol identifier this adapter implements (e.g. "openai-compatible"). */
  readonly protocol: string;

  /**
   * A minimal, cheap call proving the credential/endpoint pair works —
   * never a full generation request. The caller obtains `secret` via
   * `services/credentialSecretAccess.ts` (this function never touches the
   * vault or ciphertext itself) and passes the result to
   * `ProviderHealthService.recordObservation()` — this function does not
   * persist anything itself.
   */
  checkHealth(secret: string, config: ProviderAdapterConfig): Promise<ProviderHealthCheckResult>;

  /**
   * Translates `request` into the protocol's wire format, sends it, and
   * normalizes the result. Like `checkHealth`, `secret` is a
   * caller-supplied decrypted value (via `credentialSecretAccess.ts`) —
   * this function never decrypts, stores, or logs it.
   */
  execute(
    secret: string,
    config: ProviderAdapterConfig,
    request: NormalizedProviderRequest,
  ): Promise<ProviderExecutionResult>;
}
