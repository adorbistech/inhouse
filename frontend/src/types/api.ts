/**
 * Types matching the real Inhouse API (Block 06 — Vendor System, Block 07 —
 * Model Catalog, Block 09 — Provider Health, Block 10 — Adapter
 * Integration). These are camelCase, matching the API's JSON contract
 * exactly. `./domain.ts` now holds only small, provider-agnostic UI state
 * types with no backend equivalent of their own.
 */

export type VendorStatus = "enabled" | "disabled" | "unavailable";
export type ModelStatus = "enabled" | "disabled";

export interface CapabilityApi {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkloadApi {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface VendorAccountApi {
  id: string;
  vendorId: string;
  slug: string;
  displayName: string;
  status: VendorStatus;
  externalAccountRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A credential uses exactly one secret storage mode (Block 08 — see
 * docs/CREDENTIAL_VAULT.md): either `secretRef` (a caller-supplied
 * external reference — never a secret itself, unchanged since Block 06)
 * or an INHOUSE-vault-managed secret, indicated by `hasManagedSecret` and
 * displayed only as `maskedSecret`. The raw/encrypted secret value is
 * never part of this type — no API response ever includes it.
 */
export interface VendorCredentialApi {
  id: string;
  vendorAccountId: string;
  credentialType: string;
  status: VendorStatus;
  secretRef: string | null;
  hasManagedSecret: boolean;
  maskedSecret: string | null;
  createdAt: string;
  updatedAt: string;
  lastTestedAt: string | null;
  lastSuccessfulAt: string | null;
}

export interface VendorApi {
  id: string;
  slug: string;
  displayName: string;
  vendorType: string;
  protocol: string;
  baseEndpoint: string;
  description: string | null;
  status: VendorStatus;
  billingType: string;
  defaultTier: number | null;
  maxTier: number | null;
  automaticFallback: boolean;
  timeoutMs: number | null;
  retryMaxAttempts: number | null;
  retryBackoffMs: number | null;
  priority: number;
  retryOnTimeout: boolean;
  retryOnRateLimit: boolean;
  retryOn5xx: boolean;
  retryOnAuthFailure: boolean;
  retryOnInvalidResponse: boolean;
  /**
   * Block 10 — computed from the backend's code-defined protocol/adapter
   * registry, never stored on the vendor row. `true` means a technical
   * adapter exists for this vendor's `protocol` (so it *could* be
   * executed once a later block adds routing/execution); `false` means
   * this provider is fully configured but not yet executable — a normal,
   * expected state, not an error. Distinct from `status`, which is
   * operator intent about whether the vendor should be used at all.
   */
  adapterSupported: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VendorDetailApi extends VendorApi {
  accounts: VendorAccountApi[];
  capabilities: CapabilityApi[];
  workloads: WorkloadApi[];
}

export interface CreateVendorPayload {
  slug: string;
  displayName: string;
  vendorType: string;
  protocol: string;
  baseEndpoint: string;
  description?: string;
  billingType: string;
  defaultTier?: number;
  maxTier?: number;
  automaticFallback?: boolean;
  timeoutMs?: number;
  retryMaxAttempts?: number;
  retryBackoffMs?: number;
  priority?: number;
  retryOnTimeout?: boolean;
  retryOnRateLimit?: boolean;
  retryOn5xx?: boolean;
  retryOnAuthFailure?: boolean;
  retryOnInvalidResponse?: boolean;
  capabilityIds?: string[];
  workloadIds?: string[];
}

export type UpdateVendorPayload = Partial<Omit<CreateVendorPayload, "capabilityIds" | "workloadIds">> & {
  status?: VendorStatus;
};

export interface ModelApi {
  id: string;
  vendorId: string;
  providerModelId: string;
  inhouseAlias: string;
  displayName: string;
  contextWindow: number | null;
  status: ModelStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ModelDetailApi extends ModelApi {
  capabilities: CapabilityApi[];
  workloads: WorkloadApi[];
}

export interface CreateModelPayload {
  vendorId: string;
  providerModelId: string;
  inhouseAlias: string;
  displayName: string;
  contextWindow?: number;
  status?: ModelStatus;
  capabilityIds?: string[];
  workloadIds?: string[];
}

/** `vendorId` is intentionally omitted — immutable after creation (see docs/API.md). */
export type UpdateModelPayload = Partial<
  Omit<CreateModelPayload, "vendorId" | "capabilityIds" | "workloadIds">
>;

export interface ModelListFilters {
  vendorId?: string;
  status?: ModelStatus;
  capabilityId?: string;
  workloadId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/** Block 09 — never `"unknown"` when stored; that's the absence of a row. */
export type ProviderHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

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
 * Never includes credentials, ciphertext, or a raw provider response —
 * only normalized, safe fields. See docs/PROVIDER_HEALTH.md.
 */
export interface ProviderHealthApi {
  vendorAccountId: string;
  status: ProviderHealthStatus;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastLatencyMs: number | null;
  lastErrorCategory: ProviderErrorCategory | null;
  lastSafeErrorCode: string | null;
}

/** Block 14A — the safe, normalized result of an admin-triggered verification. Never a provider response body or credential. */
export interface ProviderVerificationApi {
  vendorId: string;
  vendorAccountId: string;
  protocol: string;
  status: Exclude<ProviderHealthStatus, "unknown">;
  latencyMs: number | null;
  errorCategory: ProviderErrorCategory | null;
  safeErrorCode: string | null;
  message: string;
  checkedAt: string;
}

export interface ProviderHealthEventApi {
  id: string;
  vendorAccountId: string;
  status: Exclude<ProviderHealthStatus, "unknown">;
  latencyMs: number | null;
  errorCategory: ProviderErrorCategory | null;
  safeErrorCode: string | null;
  source: "manual" | "adapter";
  checkedAt: string;
  createdAt: string;
}

/**
 * Block 11 — Routing Policy & Deterministic Selection Foundation.
 * `routing_tiers`/`routing_fallback_rules` (Block 05) are unchanged;
 * these are the HTTP-facing shapes over them. See docs/ROUTING_POLICY.md.
 */
export interface RoutingTierApi {
  id: string;
  workloadId: string;
  tierNumber: number;
  vendorId: string;
  modelId: string;
  priority: number;
  enabled: boolean;
  timeoutOverrideMs: number | null;
  maxAttempts: number | null;
  createdAt: string;
  updatedAt: string;
}

export const FALLBACK_CONDITION_TYPES = [
  "on_error",
  "on_timeout",
  "on_rate_limit",
  "on_5xx",
  "on_auth_failure",
  "on_invalid_response",
] as const;
export type FallbackConditionType = (typeof FALLBACK_CONDITION_TYPES)[number];

export interface RoutingFallbackRuleApi {
  id: string;
  workloadId: string;
  fromTierId: string;
  toTierId: string;
  conditionType: FallbackConditionType;
  conditionConfig: Record<string, unknown>;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoutingTierPayload {
  vendorId: string;
  modelId: string;
  tierNumber: number;
  priority?: number;
  enabled?: boolean;
  timeoutOverrideMs?: number | null;
  maxAttempts?: number | null;
}

export interface UpdateRoutingTierPayload {
  priority?: number;
  enabled?: boolean;
  timeoutOverrideMs?: number | null;
  maxAttempts?: number | null;
}

export interface CreateRoutingFallbackRulePayload {
  fromTierId: string;
  toTierId: string;
  conditionType: FallbackConditionType;
  conditionConfig?: Record<string, unknown>;
  priority?: number;
  enabled?: boolean;
}

export interface UpdateRoutingFallbackRulePayload {
  conditionType?: FallbackConditionType;
  conditionConfig?: Record<string, unknown>;
  priority?: number;
  enabled?: boolean;
}

export interface RoutingPreviewPayload {
  workloadId: string;
  modelId?: string;
  capabilityIds?: string[];
}

/** Never `"unknown"` on `RoutingAccountCandidateApi.health` — that state is a fact about an account, always present. */
export type RoutingAggregatedHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface RoutingAccountCandidateApi {
  id: string;
  slug: string;
  displayName: string;
  status: string;
  health: RoutingAggregatedHealth;
}

export interface RoutingFallbackRuleSummaryApi {
  id: string;
  fromTierId: string;
  toTierId: string;
  conditionType: string;
  conditionConfig: Record<string, unknown>;
  priority: number;
  enabled: boolean;
}

/**
 * A dry-run candidate — never a credential, secret, or raw provider
 * response. `eligible`/`reasons` explain exactly why a candidate would
 * or would not be selected; `reasons` accumulates every applicable
 * exclusion, not just the first (see docs/ROUTING_POLICY.md).
 */
export interface RoutingCandidateApi {
  tierId: string;
  tierNumber: number;
  priority: number;
  tierEnabled: boolean;
  vendor: { id: string; slug: string; displayName: string; status: string } | null;
  model: { id: string; inhouseAlias: string; displayName: string; status: string } | null;
  health: RoutingAggregatedHealth;
  accounts: RoutingAccountCandidateApi[];
  retryPolicy: {
    timeoutMs: number | null;
    maxAttempts: number | null;
    retryOnTimeout: boolean;
    retryOnRateLimit: boolean;
    retryOn5xx: boolean;
    retryOnAuthFailure: boolean;
    retryOnInvalidResponse: boolean;
  } | null;
  outgoingFallbackRules: RoutingFallbackRuleSummaryApi[];
  eligible: boolean;
  reasons: string[];
}

export type RoutingDecisionOutcome = "selected" | "no_eligible_candidate" | "no_tiers_configured";

/**
 * The full dry-run/preview result (`POST /v1/routing/preview`).
 * Configuration simulation only — never the result of an actual provider
 * call. See docs/ROUTING_POLICY.md, "Preview / Dry-Run Semantics".
 */
export interface RoutingDecisionApi {
  workload: { id: string; slug: string; displayName: string; status: string };
  requested: { modelId: string | null; capabilityIds: string[] };
  candidates: RoutingCandidateApi[];
  selectedCandidate: RoutingCandidateApi | null;
  outcome: RoutingDecisionOutcome;
  fallbackRules: RoutingFallbackRuleSummaryApi[];
  generatedAt: string;
}

/** The backend's own liveness surface (`GET /v1/health`) — never provider-specific. */
export interface SystemHealthApi {
  status: "ok";
  service: string;
  platform: "INHOUSE";
  environment: string;
  timestamp: string;
}

/**
 * An Inhouse-issued client execution key (Block 12) — never a provider
 * credential. `keyHash` never appears here; the raw key value only ever
 * appears once, in `CreateApiKeyResultApi.rawKey`, at creation time.
 */
export interface ApiKeyApi {
  id: string;
  keyId: string;
  name: string;
  status: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  /** The workloads this key may execute against (default deny — a key with none can execute nothing). */
  workloadIds: string[];
}

export interface CreateApiKeyPayload {
  name: string;
  workloadIds: string[];
  expiresAt?: string;
}

/** The one response that ever carries the raw key — never persisted or shown again after this. */
export interface CreateApiKeyResultApi {
  apiKey: ApiKeyApi;
  rawKey: string;
}

/**
 * One row of Block 12's execution/usage ledger — never a secret, a
 * credential, or raw request/response content (see migration 0008/0013's
 * comments). `providerCost`/`inhouseCost` are `null` until a pricing
 * configuration exists — never a fabricated figure.
 */
export interface UsageLedgerEntryApi {
  id: string;
  executionId: string;
  requestId: string | null;
  inhouseApiKeyId: string | null;
  vendorId: string | null;
  vendorAccountId: string | null;
  modelId: string | null;
  workloadId: string | null;
  primaryTierId: string | null;
  fallbackTierId: string | null;
  isFallback: boolean;
  attemptCount: number;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  errorCategory: string | null;
  providerRequestId: string | null;
  providerCost: string | null;
  inhouseCost: string | null;
  currency: string | null;
  createdAt: string;
}
