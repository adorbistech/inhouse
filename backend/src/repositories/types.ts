export interface VendorRow {
  id: string;
  slug: string;
  display_name: string;
  vendor_type: string;
  protocol: string;
  base_endpoint: string;
  description: string | null;
  status: string;
  billing_type: string;
  default_tier: number | null;
  max_tier: number | null;
  automatic_fallback: boolean;
  timeout_ms: number | null;
  retry_max_attempts: number | null;
  retry_backoff_ms: number | null;
  priority: number;
  retry_on_timeout: boolean;
  retry_on_rate_limit: boolean;
  retry_on_5xx: boolean;
  retry_on_auth_failure: boolean;
  retry_on_invalid_response: boolean;
  created_at: Date;
  updated_at: Date;
}

export type NewVendor = Omit<VendorRow, "id" | "created_at" | "updated_at">;

/** Partial update — every field optional, `id`/timestamps never settable. */
export type VendorPatch = Partial<NewVendor>;

export type VendorAccountPatch = Partial<Omit<NewVendorAccount, "vendor_id">>;

export type VendorCredentialPatch = Partial<
  Pick<
    VendorCredentialRow,
    | "credential_type"
    | "secret_ref"
    | "secret_ciphertext"
    | "secret_iv"
    | "secret_auth_tag"
    | "secret_fingerprint"
    | "secret_masked"
    | "secret_encryption_version"
    | "status"
  >
>;

export interface VendorAccountRow {
  id: string;
  vendor_id: string;
  slug: string;
  display_name: string;
  status: string;
  external_account_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

export type NewVendorAccount = Omit<VendorAccountRow, "id" | "created_at" | "updated_at">;

/**
 * Observed operational health for a vendor account (Block 09) — distinct
 * from `VendorAccountRow.status`, which is operator intent, not an
 * observed fact. `status` here is one of `HealthStatus` (never `"unknown"`
 * — the absence of a row *is* "unknown", see `services/providerHealthService.ts`).
 * No raw provider error body or request/response data is ever stored here
 * — see docs/PROVIDER_HEALTH.md.
 */
export interface VendorAccountHealthRow {
  id: string;
  vendor_account_id: string;
  status: string;
  consecutive_failures: number;
  last_checked_at: Date;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_latency_ms: number | null;
  last_error_category: string | null;
  last_safe_error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

export type NewVendorAccountHealth = Omit<VendorAccountHealthRow, "id" | "created_at" | "updated_at">;

/** Append-only observation history backing `vendor_account_health`. */
export interface VendorAccountHealthEventRow {
  id: string;
  vendor_account_id: string;
  status: string;
  latency_ms: number | null;
  error_category: string | null;
  safe_error_code: string | null;
  source: string;
  checked_at: Date;
  created_at: Date;
}

export type NewVendorAccountHealthEvent = Omit<VendorAccountHealthEventRow, "id" | "created_at">;

/**
 * A credential uses exactly one secret storage mode (enforced by a DB
 * CHECK constraint, migration 0011 — see docs/CREDENTIAL_VAULT.md):
 *
 * - `secret_ref` set, encrypted columns all null — a caller-supplied
 *   reference into an *external* vault/secret manager. Never a secret
 *   itself (Block 05/06 behavior, unchanged).
 * - `secret_ref` null, encrypted columns all set — INHOUSE's own
 *   authenticated-encryption vault holds the actual provider secret
 *   (Block 08). `secret_ciphertext`/`secret_iv`/`secret_auth_tag` are
 *   never serialized to an API response; only `secret_masked` is safe to
 *   display, and only a trusted backend path may decrypt (see
 *   `services/credentialSecretAccess.ts`).
 */
export interface VendorCredentialRow {
  id: string;
  vendor_account_id: string;
  credential_type: string;
  secret_ref: string | null;
  secret_ciphertext: Buffer | null;
  secret_iv: Buffer | null;
  secret_auth_tag: Buffer | null;
  secret_fingerprint: string | null;
  secret_masked: string | null;
  secret_encryption_version: number | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  last_tested_at: Date | null;
  last_successful_at: Date | null;
}

export type NewVendorCredential = Omit<
  VendorCredentialRow,
  "id" | "created_at" | "updated_at" | "last_tested_at" | "last_successful_at"
>;

export interface ModelRow {
  id: string;
  vendor_id: string;
  provider_model_id: string;
  inhouse_alias: string;
  display_name: string;
  context_window: number | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export type NewModel = Omit<ModelRow, "id" | "created_at" | "updated_at">;

/** `vendor_id` is intentionally excluded — immutable after creation (see docs/API.md). */
export type ModelPatch = Partial<Omit<NewModel, "vendor_id">>;

export interface CapabilityRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

export type NewCapability = Omit<CapabilityRow, "id" | "created_at" | "updated_at">;

export interface WorkloadRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export type NewWorkload = Omit<WorkloadRow, "id" | "created_at" | "updated_at">;

export interface RoutingTierRow {
  id: string;
  workload_id: string;
  tier_number: number;
  vendor_id: string;
  model_id: string;
  priority: number;
  enabled: boolean;
  timeout_override_ms: number | null;
  max_attempts: number | null;
  created_at: Date;
  updated_at: Date;
}

export type NewRoutingTier = Omit<RoutingTierRow, "id" | "created_at" | "updated_at">;

export interface RoutingFallbackRuleRow {
  id: string;
  workload_id: string;
  from_tier_id: string;
  to_tier_id: string;
  condition_type: string;
  condition_config: Record<string, unknown>;
  priority: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export type NewRoutingFallbackRule = Omit<RoutingFallbackRuleRow, "id" | "created_at" | "updated_at">;

/**
 * `workload_id`/`vendor_id`/`model_id`/`tier_number` are intentionally
 * excluded — they define the tier's identity (and its uniqueness
 * constraint); changing which vendor/model/workload/position a tier
 * represents is a delete-and-recreate, not a patch (see docs/API.md,
 * mirroring `ModelPatch` excluding `vendor_id`).
 */
export type RoutingTierPatch = Partial<
  Pick<RoutingTierRow, "priority" | "enabled" | "timeout_override_ms" | "max_attempts">
>;

/**
 * `workload_id`/`from_tier_id`/`to_tier_id` are intentionally excluded —
 * they define which two tiers this rule connects; repointing a rule at
 * different tiers is a delete-and-recreate, not a patch.
 */
export type RoutingFallbackRulePatch = Partial<
  Pick<RoutingFallbackRuleRow, "condition_type" | "condition_config" | "priority" | "enabled">
>;

export interface InhouseApiKeyRow {
  id: string;
  key_id: string;
  name: string;
  key_hash: string;
  permissions: unknown[];
  status: string;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
}

export type NewInhouseApiKey = Omit<InhouseApiKeyRow, "id" | "created_at" | "last_used_at">;

export interface UsageLedgerRow {
  id: string;
  execution_id: string;
  request_id: string | null;
  inhouse_api_key_id: string | null;
  vendor_id: string | null;
  vendor_account_id: string | null;
  model_id: string | null;
  workload_id: string | null;
  primary_tier_id: string | null;
  fallback_tier_id: string | null;
  is_fallback: boolean;
  attempt_count: number;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  latency_ms: number | null;
  error_category: string | null;
  provider_request_id: string | null;
  provider_cost: string | null;
  inhouse_cost: string | null;
  currency: string | null;
  created_at: Date;
}

export type NewUsageLedgerEntry = Omit<UsageLedgerRow, "id" | "created_at">;

export interface AuditEventRow {
  id: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  request_id: string | null;
  created_at: Date;
}

export type NewAuditEvent = Omit<AuditEventRow, "id" | "created_at">;
