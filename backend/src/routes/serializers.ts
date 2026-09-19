import type {
  CapabilityRow,
  ModelRow,
  VendorAccountHealthEventRow,
  VendorAccountHealthRow,
  VendorAccountRow,
  VendorRow,
  WorkloadRow,
} from "../repositories/types.js";
import type { ModelDetail } from "../services/modelService.js";
import type { VendorDetail } from "../services/vendorService.js";

/**
 * Every Vendor System HTTP response is camelCase, regardless of the
 * underlying snake_case column names — these are the single projection
 * points responsible for that mapping, matching the camelCase request-body
 * convention already used for creates/patches.
 */
export function toCapabilityResponse(capability: CapabilityRow) {
  return {
    id: capability.id,
    slug: capability.slug,
    displayName: capability.display_name,
    description: capability.description,
    createdAt: capability.created_at,
    updatedAt: capability.updated_at,
  };
}

export function toWorkloadResponse(workload: WorkloadRow) {
  return {
    id: workload.id,
    slug: workload.slug,
    displayName: workload.display_name,
    description: workload.description,
    status: workload.status,
    createdAt: workload.created_at,
    updatedAt: workload.updated_at,
  };
}

export function toAccountResponse(account: VendorAccountRow) {
  return {
    id: account.id,
    vendorId: account.vendor_id,
    slug: account.slug,
    displayName: account.display_name,
    status: account.status,
    externalAccountRef: account.external_account_ref,
    createdAt: account.created_at,
    updatedAt: account.updated_at,
  };
}

export function toVendorResponse(vendor: VendorRow) {
  return {
    id: vendor.id,
    slug: vendor.slug,
    displayName: vendor.display_name,
    vendorType: vendor.vendor_type,
    protocol: vendor.protocol,
    baseEndpoint: vendor.base_endpoint,
    description: vendor.description,
    status: vendor.status,
    billingType: vendor.billing_type,
    defaultTier: vendor.default_tier,
    maxTier: vendor.max_tier,
    automaticFallback: vendor.automatic_fallback,
    timeoutMs: vendor.timeout_ms,
    retryMaxAttempts: vendor.retry_max_attempts,
    retryBackoffMs: vendor.retry_backoff_ms,
    priority: vendor.priority,
    retryOnTimeout: vendor.retry_on_timeout,
    retryOnRateLimit: vendor.retry_on_rate_limit,
    retryOn5xx: vendor.retry_on_5xx,
    retryOnAuthFailure: vendor.retry_on_auth_failure,
    retryOnInvalidResponse: vendor.retry_on_invalid_response,
    createdAt: vendor.created_at,
    updatedAt: vendor.updated_at,
  };
}

export function toVendorDetailResponse(detail: VendorDetail) {
  return {
    ...toVendorResponse(detail),
    accounts: detail.accounts.map(toAccountResponse),
    capabilities: detail.capabilities.map(toCapabilityResponse),
    workloads: detail.workloads.map(toWorkloadResponse),
  };
}

export function toModelResponse(model: ModelRow) {
  return {
    id: model.id,
    vendorId: model.vendor_id,
    providerModelId: model.provider_model_id,
    inhouseAlias: model.inhouse_alias,
    displayName: model.display_name,
    contextWindow: model.context_window,
    status: model.status,
    createdAt: model.created_at,
    updatedAt: model.updated_at,
  };
}

export function toModelDetailResponse(detail: ModelDetail) {
  return {
    ...toModelResponse(detail),
    capabilities: detail.capabilities.map(toCapabilityResponse),
    workloads: detail.workloads.map(toWorkloadResponse),
  };
}

/**
 * `null` means "unknown" — this account has never been observed (see
 * `services/providerHealthService.ts`). Never includes a raw provider
 * error body; only `safeErrorCode`/`errorCategory`, both normalized,
 * technical, and provider-agnostic.
 */
export function toProviderHealthResponse(vendorAccountId: string, health: VendorAccountHealthRow | null) {
  if (!health) {
    return {
      vendorAccountId,
      status: "unknown" as const,
      consecutiveFailures: 0,
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastLatencyMs: null,
      lastErrorCategory: null,
      lastSafeErrorCode: null,
    };
  }
  return {
    vendorAccountId: health.vendor_account_id,
    status: health.status,
    consecutiveFailures: health.consecutive_failures,
    lastCheckedAt: health.last_checked_at,
    lastSuccessAt: health.last_success_at,
    lastFailureAt: health.last_failure_at,
    lastLatencyMs: health.last_latency_ms,
    lastErrorCategory: health.last_error_category,
    lastSafeErrorCode: health.last_safe_error_code,
  };
}

export function toProviderHealthEventResponse(event: VendorAccountHealthEventRow) {
  return {
    id: event.id,
    vendorAccountId: event.vendor_account_id,
    status: event.status,
    latencyMs: event.latency_ms,
    errorCategory: event.error_category,
    safeErrorCode: event.safe_error_code,
    source: event.source,
    checkedAt: event.checked_at,
    createdAt: event.created_at,
  };
}
