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

export interface VendorCredentialApi {
  id: string;
  vendorAccountId: string;
  credentialType: string;
  status: VendorStatus;
  /** A reference (e.g. a vault path), never a plaintext provider secret. */
  secretRef: string;
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
