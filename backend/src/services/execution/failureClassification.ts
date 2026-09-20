import type { VendorRow } from "../../repositories/types.js";
import type { RoutingAccountCandidate, RoutingFallbackRuleSummary } from "../routingService.js";
import type { ExecutionErrorCategory } from "./types.js";

/** Hard ceiling regardless of `vendors.retry_backoff_ms` — bounded execution (Block 12 rule 6/7). */
export const MAX_BACKOFF_MS = 2_000;
const DEFAULT_BACKOFF_MS = 250;

/** healthy < unknown < degraded < unhealthy — the same relative ordering `aggregateAccountHealth` (routingService.ts) treats as increasingly unsafe. */
export function healthRank(health: RoutingAccountCandidate["health"]): number {
  if (health === "healthy") return 0;
  if (health === "unknown") return 1;
  if (health === "degraded") return 2;
  return 3;
}

/**
 * Whether a failure category is ever retried on the *same* candidate, and
 * which vendor-level flag (Block 06, unchanged) governs it. `"network"` is
 * deliberately folded into the same flag as `"timeout"` — both are
 * transient-connectivity failures, not a provider decision. Every other
 * category (`invalid_request`, `model_not_found`, `configuration`,
 * `unknown`) is never retried — retrying a malformed request or a missing
 * model against the same vendor cannot succeed differently the second time.
 */
export function isRetryableCategory(category: ExecutionErrorCategory, vendor: VendorRow): boolean {
  switch (category) {
    case "timeout":
    case "network":
      return vendor.retry_on_timeout;
    case "rate_limit":
      return vendor.retry_on_rate_limit;
    case "provider_error":
    case "unavailable":
      return vendor.retry_on_5xx;
    case "authentication":
    case "authorization":
      return vendor.retry_on_auth_failure;
    default:
      return false;
  }
}

/**
 * Maps a failure onto Block 11's fixed `condition_type` vocabulary
 * (`validation/routing.ts`'s `FALLBACK_CONDITION_TYPES`) without touching
 * or duplicating it. `"on_invalid_response"` is deliberately distinguished
 * from `"on_5xx"` using `safeErrorCode`: the adapter (Block 10, unchanged)
 * reports a real HTTP 5xx with `safeErrorCode` set to the status string,
 * but a malformed/unparseable provider body — which never reached an
 * HTTP-status branch — with `safeErrorCode: null`. Both currently surface
 * as `category: "provider_error"`; this is the one place that distinction
 * is recovered, without changing the adapter contract.
 */
export function conditionMatches(conditionType: string, category: ExecutionErrorCategory, safeErrorCode: string | null): boolean {
  switch (conditionType) {
    case "on_error":
      return true;
    case "on_timeout":
      return category === "timeout" || category === "network";
    case "on_rate_limit":
      return category === "rate_limit";
    case "on_invalid_response":
      return category === "provider_error" && safeErrorCode === null;
    case "on_5xx":
      return (category === "provider_error" && safeErrorCode !== null) || category === "unavailable";
    case "on_auth_failure":
      return category === "authentication" || category === "authorization";
    default:
      return false;
  }
}

/** Highest-priority enabled rule whose condition matches this failure — never more than one candidate rule is chosen. */
export function pickFallbackRule(
  rules: RoutingFallbackRuleSummary[],
  category: ExecutionErrorCategory,
  safeErrorCode: string | null,
): RoutingFallbackRuleSummary | null {
  const matching = rules.filter((r) => r.enabled && conditionMatches(r.conditionType, category, safeErrorCode));
  if (matching.length === 0) return null;
  return [...matching].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0]!;
}

/** Fixed, bounded backoff — never exponential/unbounded, so total retry wall-clock time is always predictable. */
export function boundedBackoffMs(vendorBackoffMs: number | null): number {
  return Math.min(vendorBackoffMs ?? DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS);
}
