/**
 * Types matching the real Inhouse API (Block 06 — Vendor System, Block 07 —
 * Model Catalog). These are camelCase, matching the API's JSON contract
 * exactly — distinct from the Block 02 mock domain model in `./domain.ts`,
 * which the Dashboard and Settings "Routing"/"Accounting" tabs still use
 * for their still-mock sections.
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
