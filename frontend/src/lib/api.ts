import type {
  AccountReadinessApi,
  ApiKeyApi,
  CapabilityApi,
  CreateApiKeyPayload,
  CreateApiKeyResultApi,
  CreateModelPayload,
  CreateRoutingFallbackRulePayload,
  CreateRoutingTierPayload,
  CreateVendorPayload,
  ModelApi,
  ModelDetailApi,
  ModelListFilters,
  ProviderHealthApi,
  ProviderHealthEventApi,
  ProviderVerificationApi,
  RoutingDecisionApi,
  RoutingFallbackRuleApi,
  RoutingPreviewPayload,
  RoutingTierApi,
  SystemHealthApi,
  UpdateModelPayload,
  UpdateRoutingFallbackRulePayload,
  UpdateRoutingTierPayload,
  UpdateVendorPayload,
  UsageLedgerEntryApi,
  VendorAccountApi,
  VendorApi,
  VendorCredentialApi,
  VendorDetailApi,
  WorkloadApi,
} from "../types/api";

/**
 * Base URL for the Inhouse API. Defaults to a relative `/v1` so the built
 * frontend works behind whatever reverse proxy serves it in production;
 * override with `VITE_INHOUSE_API_BASE_URL` for local development against
 * a directly-reachable backend (e.g. `http://127.0.0.1:8092/v1`).
 */
const API_BASE_URL = (import.meta.env.VITE_INHOUSE_API_BASE_URL as string | undefined) ?? "/v1";

const ADMIN_TOKEN_STORAGE_KEY = "inhouse.adminToken";

/**
 * The control-plane administrative token (Block 12/12E) guarding every
 * control-plane call: vendors, accounts, credentials, models, workloads,
 * capabilities, routing, provider health, API keys and usage. Held in this browser tab's
 * `sessionStorage` only — never `localStorage`, never in the bundle, never
 * sent anywhere except as the `Authorization` header of calls to the
 * Inhouse API itself (never a provider, never the public health probe) — so it disappears when the tab closes. Every storage access is
 * guarded: the page must work (as "not signed in") when storage is blocked.
 */
export const adminToken = {
  get(): string | null {
    try {
      return sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set(token: string): void {
    try {
      sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
    } catch {
      // Storage unavailable: the token simply is not remembered.
    }
  },
  clear(): void {
    try {
      sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    } catch {
      // ignore
    }
  },
};

function adminHeaders(): Record<string, string> {
  const token = adminToken.get();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; requestId?: string };
}

/** Infrastructure probes the backend leaves unauthenticated; they never carry the admin token. */
const PUBLIC_PATHS = new Set(["/health", "/ready"]);

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(PUBLIC_PATHS.has(path) ? {} : adminHeaders()),
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : null;

  if (!res.ok) {
    const errorBody = body as ErrorBody | null;
    throw new ApiError(
      res.status,
      errorBody?.error?.code ?? "UNKNOWN_ERROR",
      errorBody?.error?.message ?? "Request failed.",
      errorBody?.error?.requestId ?? "",
    );
  }

  return body as T;
}

/**
 * The credential wire shape includes the external `secretRef`. It is never
 * needed by the UI, so it is dropped here, at the boundary, and never
 * reaches component state. Only the fields `VendorCredentialApi` declares survive.
 */
function toSafeCredential(raw: VendorCredentialApi): VendorCredentialApi {
  return {
    id: raw.id,
    vendorAccountId: raw.vendorAccountId,
    credentialType: raw.credentialType,
    status: raw.status,
    hasManagedSecret: raw.hasManagedSecret,
    maskedSecret: raw.maskedSecret,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    lastTestedAt: raw.lastTestedAt,
    lastSuccessfulAt: raw.lastSuccessfulAt,
  };
}

export const api = {
  listVendors: (status?: string) =>
    request<{ vendors: VendorApi[] }>(`/vendors${status ? `?status=${encodeURIComponent(status)}` : ""}`),

  getVendor: (id: string) => request<{ vendor: VendorDetailApi }>(`/vendors/${id}`),

  createVendor: (payload: CreateVendorPayload) =>
    request<{ vendor: VendorDetailApi }>("/vendors", { method: "POST", body: JSON.stringify(payload) }),

  updateVendor: (id: string, patch: UpdateVendorPayload) =>
    request<{ vendor: VendorDetailApi }>(`/vendors/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  disableVendor: (id: string) => request<{ vendor: VendorDetailApi }>(`/vendors/${id}`, { method: "DELETE" }),

  enableVendor: (id: string) =>
    request<{ vendor: VendorDetailApi }>(`/vendors/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "enabled" }),
    }),

  setVendorCapabilities: (id: string, capabilityIds: string[]) =>
    request<{ capabilities: CapabilityApi[] }>(`/vendors/${id}/capabilities`, {
      method: "PUT",
      body: JSON.stringify({ capabilityIds }),
    }),

  setVendorWorkloads: (id: string, workloadIds: string[]) =>
    request<{ workloads: WorkloadApi[] }>(`/vendors/${id}/workloads`, {
      method: "PUT",
      body: JSON.stringify({ workloadIds }),
    }),

  listAccounts: (vendorId: string) => request<{ accounts: VendorAccountApi[] }>(`/vendors/${vendorId}/accounts`),

  createAccount: (vendorId: string, payload: { slug: string; displayName: string; externalAccountRef?: string }) =>
    request<{ account: VendorAccountApi }>(`/vendors/${vendorId}/accounts`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateAccount: (
    vendorId: string,
    accountId: string,
    patch: { slug?: string; displayName?: string; status?: string; externalAccountRef?: string | null },
  ) =>
    request<{ account: VendorAccountApi }>(`/vendors/${vendorId}/accounts/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  disableAccount: (vendorId: string, accountId: string) =>
    request<{ account: VendorAccountApi }>(`/vendors/${vendorId}/accounts/${accountId}`, { method: "DELETE" }),

  listCredentials: (vendorId: string) =>
    request<{ credentials: VendorCredentialApi[] }>(`/vendors/${vendorId}/credentials`).then((r) => ({
      credentials: r.credentials.map(toSafeCredential),
    })),

  createCredential: (
    vendorId: string,
    payload:
      | { vendorAccountId: string; credentialType: string; secretRef: string }
      | { vendorAccountId: string; credentialType: string; secret: string },
  ) =>
    request<{ credential: VendorCredentialApi }>(`/vendors/${vendorId}/credentials`, {
      method: "POST",
      body: JSON.stringify(payload),
    }).then((r) => ({ credential: toSafeCredential(r.credential) })),

  updateCredential: (
    vendorId: string,
    credentialId: string,
    patch: { credentialType?: string; secretRef?: string; secret?: string; status?: string },
  ) =>
    request<{ credential: VendorCredentialApi }>(`/vendors/${vendorId}/credentials/${credentialId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }).then((r) => ({ credential: toSafeCredential(r.credential) })),

  deleteCredential: (vendorId: string, credentialId: string) =>
    request<void>(`/vendors/${vendorId}/credentials/${credentialId}`, { method: "DELETE" }),

  listCapabilities: () => request<{ capabilities: CapabilityApi[] }>("/capabilities"),

  listWorkloads: () => request<{ workloads: WorkloadApi[] }>("/workloads"),

  listModels: (filters: ModelListFilters = {}) => {
    const params = new URLSearchParams();
    if (filters.vendorId) params.set("vendorId", filters.vendorId);
    if (filters.status) params.set("status", filters.status);
    if (filters.capabilityId) params.set("capabilityId", filters.capabilityId);
    if (filters.workloadId) params.set("workloadId", filters.workloadId);
    if (filters.search) params.set("search", filters.search);
    if (filters.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters.offset !== undefined) params.set("offset", String(filters.offset));
    const query = params.toString();
    return request<{ models: ModelApi[] }>(`/models${query ? `?${query}` : ""}`);
  },

  getModel: (id: string) => request<{ model: ModelDetailApi }>(`/models/${id}`),

  createModel: (payload: CreateModelPayload) =>
    request<{ model: ModelDetailApi }>("/models", { method: "POST", body: JSON.stringify(payload) }),

  updateModel: (id: string, patch: UpdateModelPayload) =>
    request<{ model: ModelDetailApi }>(`/models/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  disableModel: (id: string) => request<{ model: ModelDetailApi }>(`/models/${id}`, { method: "DELETE" }),

  enableModel: (id: string) =>
    request<{ model: ModelDetailApi }>(`/models/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "enabled" }),
    }),

  setModelCapabilities: (id: string, capabilityIds: string[]) =>
    request<{ capabilities: CapabilityApi[] }>(`/models/${id}/capabilities`, {
      method: "PUT",
      body: JSON.stringify({ capabilityIds }),
    }),

  setModelWorkloads: (id: string, workloadIds: string[]) =>
    request<{ workloads: WorkloadApi[] }>(`/models/${id}/workloads`, {
      method: "PUT",
      body: JSON.stringify({ workloadIds }),
    }),

  getAccountHealth: (vendorId: string, accountId: string) =>
    request<{ health: ProviderHealthApi }>(`/vendors/${vendorId}/accounts/${accountId}/health`),

  verifyAccount: (vendorId: string, accountId: string) =>
    request<{ verification: ProviderVerificationApi }>(`/vendors/${vendorId}/accounts/${accountId}/verify`, {
      method: "POST",
      body: "{}",
    }),

  getAccountReadiness: (vendorId: string, accountId: string) =>
    request<{ readiness: AccountReadinessApi }>(`/vendors/${vendorId}/accounts/${accountId}/readiness`),

  getAccountHealthEvents: (vendorId: string, accountId: string, limit?: number) =>
    request<{ events: ProviderHealthEventApi[] }>(
      `/vendors/${vendorId}/accounts/${accountId}/health/events${limit ? `?limit=${limit}` : ""}`,
    ),

  getSystemHealth: () => request<SystemHealthApi>("/health"),

  // --- Routing Policy (Block 11) ---

  getRoutingConfig: (workloadId: string) =>
    request<{ workload: WorkloadApi; tiers: RoutingTierApi[]; fallbackRules: RoutingFallbackRuleApi[] }>(
      `/routing/workloads/${workloadId}`,
    ),

  listRoutingTiers: (workloadId: string) =>
    request<{ tiers: RoutingTierApi[] }>(`/routing/workloads/${workloadId}/tiers`),

  createRoutingTier: (workloadId: string, payload: CreateRoutingTierPayload) =>
    request<{ tier: RoutingTierApi }>(`/routing/workloads/${workloadId}/tiers`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateRoutingTier: (workloadId: string, tierId: string, patch: UpdateRoutingTierPayload) =>
    request<{ tier: RoutingTierApi }>(`/routing/workloads/${workloadId}/tiers/${tierId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  disableRoutingTier: (workloadId: string, tierId: string) =>
    request<{ tier: RoutingTierApi }>(`/routing/workloads/${workloadId}/tiers/${tierId}`, { method: "DELETE" }),

  enableRoutingTier: (workloadId: string, tierId: string) =>
    request<{ tier: RoutingTierApi }>(`/routing/workloads/${workloadId}/tiers/${tierId}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    }),

  listRoutingFallbackRules: (workloadId: string) =>
    request<{ fallbackRules: RoutingFallbackRuleApi[] }>(`/routing/workloads/${workloadId}/fallback-rules`),

  createRoutingFallbackRule: (workloadId: string, payload: CreateRoutingFallbackRulePayload) =>
    request<{ fallbackRule: RoutingFallbackRuleApi }>(`/routing/workloads/${workloadId}/fallback-rules`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateRoutingFallbackRule: (workloadId: string, ruleId: string, patch: UpdateRoutingFallbackRulePayload) =>
    request<{ fallbackRule: RoutingFallbackRuleApi }>(`/routing/workloads/${workloadId}/fallback-rules/${ruleId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  disableRoutingFallbackRule: (workloadId: string, ruleId: string) =>
    request<{ fallbackRule: RoutingFallbackRuleApi }>(`/routing/workloads/${workloadId}/fallback-rules/${ruleId}`, {
      method: "DELETE",
    }),

  previewRouting: (payload: RoutingPreviewPayload) =>
    request<{ decision: RoutingDecisionApi }>("/routing/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // --- Execution & Claude Integration (Block 12) ---

  listApiKeys: () => request<{ apiKeys: ApiKeyApi[] }>("/api-keys"),

  createApiKey: (payload: CreateApiKeyPayload) =>
    request<CreateApiKeyResultApi>("/api-keys", { method: "POST", body: JSON.stringify(payload) }),

  setApiKeyWorkloads: (id: string, workloadIds: string[]) =>
    request<{ apiKey: ApiKeyApi }>(`/api-keys/${id}/workloads`, {
      method: "PUT",
      body: JSON.stringify({ workloadIds }),
    }),

  revokeApiKey: (id: string) =>
    request<{ apiKey: ApiKeyApi }>(`/api-keys/${id}`, { method: "DELETE" }),

  listUsage: (limit?: number) =>
    request<{ usage: UsageLedgerEntryApi[] }>(`/usage${limit ? `?limit=${limit}` : ""}`),
};
