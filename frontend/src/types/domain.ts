/**
 * Inhouse domain model — Block 02 (Frontend Shell).
 *
 * Represents the full concept chain the frontend must be able to display,
 * even though only mock data is wired up in this block:
 *
 *   ONE INHOUSE API KEY -> INHOUSE API -> MoE ROUTER -> VENDORS -> VENDOR ACCOUNTS/CREDENTIALS
 *
 * `InhouseApiKey` (client-facing) and `VendorCredential` (provider-facing) are
 * intentionally separate credential classes — they are never interchangeable.
 */

export type HealthState = "healthy" | "degraded" | "disabled" | "unreachable";

export type VendorPlanType =
  | "coding_plan"
  | "payg"
  | "general_api"
  | "local"
  | "custom";

export type ApiProtocol = "openai_compatible" | "anthropic_compatible" | "custom_rest";

export type CapabilityFlag =
  | "streaming"
  | "tool_calling"
  | "vision"
  | "multimodal"
  | "reasoning"
  | "json_output"
  | "prompt_caching"
  | "web_search";

export type WorkloadType =
  | "coding_agent"
  | "application_api"
  | "automation"
  | "research"
  | "internal";

export type RoutingTier =
  | "tier_1_high_reliability"
  | "tier_2_standard"
  | "tier_3_batch";

export type AuthType = "api_key" | "bearer_token" | "aws_iam_role" | "mtls_client_cert";

export type CredentialValidity = "valid" | "invalid" | "untested" | "expired";

/** Provider-facing secret. Never rendered in full — only masked + fingerprint. */
export interface VendorCredential {
  id: string;
  vendorAccountId: string;
  authType: AuthType;
  maskedSecret: string;
  fingerprint: string;
  vaultStore: string;
  createdAt: string;
  lastTestedAt: string | null;
  lastTestResult: "200_ok" | "timeout" | "rate_limited" | "auth_failure" | null;
  validity: CredentialValidity;
}

/** A concrete account/tenant under a vendor (a vendor may have several). */
export interface VendorAccount {
  id: string;
  vendorId: string;
  label: string;
  environment: "production" | "staging" | "sandbox";
  credential: VendorCredential;
  quotaUsedPercent: number;
  quotaResetAt: string | null;
  status: HealthState;
  createdAt: string;
}

export interface ModelCostProfile {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd: number | null;
}

export interface Model {
  id: string;
  vendorId: string;
  displayName: string;
  modelId: string;
  contextWindowTokens: number;
  capabilities: CapabilityFlag[];
  cost: ModelCostProfile;
  status: HealthState;
}

export interface FallbackConfig {
  enabled: boolean;
  fallbackOnTimeout: boolean;
  fallbackOnRateLimit: boolean;
  fallbackOnProviderError: boolean;
  fallbackOnQuotaExhaustion: boolean;
  fallbackOnAuthFailure: boolean;
  maxProviderAttempts: number;
  maxTotalExecutionTimeMs: number;
}

export interface HealthSnapshot {
  state: HealthState;
  uptimePercent: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  errorRatePercent: number;
  lastIncidentAt: string | null;
  lastPingAt: string;
}

/** Per-vendor usage/consumption snapshot, shown in the vendor inspector's Usage tab. */
export interface UsageSnapshot {
  windowLabel: string;
  requests: number;
  tokensInputTotal: number;
  tokensOutputTotal: number;
  costUsd: number;
  successRatePercent: number;
}

export interface Vendor {
  id: string;
  name: string;
  slug: string;
  initial: string;
  planType: VendorPlanType;
  protocol: ApiProtocol;
  baseEndpoint: string;
  description: string;
  accounts: VendorAccount[];
  models: Model[];
  capabilities: CapabilityFlag[];
  workloads: WorkloadType[];
  priority: number; // 1 (fallback) - 10 (primary)
  tier: RoutingTier;
  fallback: FallbackConfig;
  health: HealthSnapshot;
  usage: UsageSnapshot;
  createdAt: string;
}

/** Aggregate platform-wide KPI figures shown on the Dashboard command center. */
export interface PlatformMetrics {
  tokensInLast24h: number;
  tokensOutLast24h: number;
  avgLatencyP95Ms: number;
  betaCostUsd: number;
  betaCostAllocationPercent: number;
}

/** Client-facing credential class. Distinct from VendorCredential. */
export interface InhouseApiKey {
  id: string;
  label: string;
  tokenPrefix: string;
  scopes: string[];
  state: "active" | "revoked" | "rotating";
  createdAt: string;
  lastUsedAt: string | null;
}

export interface RoutingLadderRung {
  rank: number;
  vendorId: string;
  modelId: string;
  priorityBias: number;
  triggerCondition: string;
}

export interface RoutingPolicy {
  workload: WorkloadType;
  activeVendorId: string;
  ladder: RoutingLadderRung[];
}

export interface TelemetryPoint {
  timeLabel: string;
  requests: number;
  successful: number;
  failed: number;
  fallbacks: number;
}

export interface FailoverEvent {
  id: string;
  step: number;
  actor: "client" | "router" | "vendor";
  label: string;
  detail: string;
  status: "timeout" | "rate_limited" | "completed" | "resolved" | "triggered";
  durationMs: number | null;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  status: "ok" | "warning" | "error";
}
