/**
 * Types matching the real Inhouse API (Block 06 — Vendor System). These
 * are camelCase, matching the API's JSON contract exactly — distinct from
 * the Block 02 mock domain model in `./domain.ts`, which the Dashboard and
 * Settings pages still use for their still-mock sections.
 */

export type VendorStatus = "enabled" | "disabled" | "unavailable";

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
