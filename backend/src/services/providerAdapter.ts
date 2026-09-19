/**
 * The shape a future provider adapter (Block 10+) will implement to
 * perform a real health check against a vendor's API, using a decrypted
 * credential obtained via `credentialSecretAccess.ts`. Block 09 defines
 * this interface only — nothing in this codebase implements or calls it,
 * and nothing here makes a network request. A real adapter's
 * `checkHealth()` result is what `ProviderHealthService.recordObservation()`
 * (see `providerHealthService.ts`) expects as input, so the boundary
 * between "an adapter observes reality" and "the health service persists
 * it" is explicit and provider-agnostic — no `if (vendorType === "...")`
 * anywhere in this file or its caller.
 */

export type ProviderHealthStatus = "healthy" | "degraded" | "unhealthy";

/**
 * Technical, provider-agnostic failure classifications — not provider
 * names or provider-specific error codes. A real adapter is responsible
 * for mapping whatever a provider actually returns onto this fixed set.
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
 * A future adapter takes a decrypted secret (never persisted, never
 * logged by the adapter or by anything that calls it) and returns a
 * normalized result. Implementing this for a real provider is explicitly
 * out of scope for Block 09.
 */
export interface ProviderAdapter {
  checkHealth(secret: string): Promise<ProviderHealthCheckResult>;
}
