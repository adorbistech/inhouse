import type {
  CapabilityApi,
  CreateModelPayload,
  CreateVendorPayload,
  ModelApi,
  ModelDetailApi,
  ModelListFilters,
  UpdateModelPayload,
  UpdateVendorPayload,
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
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
    patch: { displayName?: string; status?: string; externalAccountRef?: string },
  ) =>
    request<{ account: VendorAccountApi }>(`/vendors/${vendorId}/accounts/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  disableAccount: (vendorId: string, accountId: string) =>
    request<{ account: VendorAccountApi }>(`/vendors/${vendorId}/accounts/${accountId}`, { method: "DELETE" }),

  listCredentials: (vendorId: string) =>
    request<{ credentials: VendorCredentialApi[] }>(`/vendors/${vendorId}/credentials`),

  createCredential: (
    vendorId: string,
    payload: { vendorAccountId: string; credentialType: string; secretRef: string },
  ) =>
    request<{ credential: VendorCredentialApi }>(`/vendors/${vendorId}/credentials`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateCredential: (
    vendorId: string,
    credentialId: string,
    patch: { credentialType?: string; secretRef?: string; status?: string },
  ) =>
    request<{ credential: VendorCredentialApi }>(`/vendors/${vendorId}/credentials/${credentialId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

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
};
