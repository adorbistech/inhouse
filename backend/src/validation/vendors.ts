import { ValidationError } from "../lib/httpErrors.js";
import type { NewVendor, NewVendorAccount, VendorAccountPatch, VendorPatch } from "../repositories/types.js";

export const VENDOR_STATUSES = ["enabled", "disabled", "unavailable"] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, { maxLength = 200 } = {}): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`"${field}" is required and must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new ValidationError(`"${field}" must be at most ${maxLength} characters.`);
  }
  return value;
}

function optionalString(value: unknown, field: string, { maxLength = 2000 } = {}): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ValidationError(`"${field}" must be a string.`);
  }
  if (value.length > maxLength) {
    throw new ValidationError(`"${field}" must be at most ${maxLength} characters.`);
  }
  return value;
}

function requireSlug(value: unknown, field: string): string {
  const str = requireString(value, field, { maxLength: 100 });
  if (!SLUG_PATTERN.test(str)) {
    throw new ValidationError(
      `"${field}" must be a lowercase, dash-separated identifier (e.g. "my-vendor-01").`,
    );
  }
  return str;
}

function requireStatus(value: unknown, field = "status"): VendorStatus {
  const str = requireString(value, field, { maxLength: 20 });
  if (!VENDOR_STATUSES.includes(str as VendorStatus)) {
    throw new ValidationError(`"${field}" must be one of: ${VENDOR_STATUSES.join(", ")}.`);
  }
  return str as VendorStatus;
}

function requireBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new ValidationError(`"${field}" must be a boolean.`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ValidationError(`"${field}" must be a boolean.`);
  }
  return value;
}

function requireNonNegativeInt(value: unknown, field: string, { max }: { max?: number } = {}): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`"${field}" must be a non-negative integer.`);
  }
  if (max !== undefined && value > max) {
    throw new ValidationError(`"${field}" must be at most ${max}.`);
  }
  return value;
}

function optionalNonNegativeInt(value: unknown, field: string, opts: { max?: number } = {}): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireNonNegativeInt(value, field, opts);
}

function requireHttpUrl(value: unknown, field: string): string {
  const str = requireString(value, field, { maxLength: 500 });
  if (!/^https?:\/\/.+/i.test(str)) {
    throw new ValidationError(`"${field}" must be an http(s) URL.`);
  }
  return str;
}

function optionalIdArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.length > 0)) {
    throw new ValidationError(`"${field}" must be an array of ID strings.`);
  }
  return value;
}

export interface CreateVendorInput {
  vendor: NewVendor;
  capabilityIds?: string[];
  workloadIds?: string[];
}

export function validateCreateVendorInput(body: unknown): CreateVendorInput {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }

  const vendor: NewVendor = {
    slug: requireSlug(body.slug, "slug"),
    display_name: requireString(body.displayName, "displayName"),
    vendor_type: requireString(body.vendorType, "vendorType", { maxLength: 100 }),
    protocol: requireString(body.protocol, "protocol", { maxLength: 100 }),
    base_endpoint: requireHttpUrl(body.baseEndpoint, "baseEndpoint"),
    description: optionalString(body.description, "description"),
    status: requireStatus(body.status ?? "enabled"),
    billing_type: requireString(body.billingType, "billingType", { maxLength: 100 }),
    default_tier: optionalNonNegativeInt(body.defaultTier, "defaultTier") ?? null,
    max_tier: optionalNonNegativeInt(body.maxTier, "maxTier") ?? null,
    automatic_fallback: requireBoolean(body.automaticFallback, "automaticFallback", false),
    timeout_ms: optionalNonNegativeInt(body.timeoutMs, "timeoutMs") ?? null,
    retry_max_attempts: optionalNonNegativeInt(body.retryMaxAttempts, "retryMaxAttempts", { max: 20 }) ?? null,
    retry_backoff_ms: optionalNonNegativeInt(body.retryBackoffMs, "retryBackoffMs") ?? null,
    priority: requireNonNegativeInt(body.priority ?? 0, "priority", { max: 10 }),
    retry_on_timeout: requireBoolean(body.retryOnTimeout, "retryOnTimeout", false),
    retry_on_rate_limit: requireBoolean(body.retryOnRateLimit, "retryOnRateLimit", false),
    retry_on_5xx: requireBoolean(body.retryOn5xx, "retryOn5xx", false),
    retry_on_auth_failure: requireBoolean(body.retryOnAuthFailure, "retryOnAuthFailure", false),
    retry_on_invalid_response: requireBoolean(body.retryOnInvalidResponse, "retryOnInvalidResponse", false),
  };

  if (vendor.default_tier !== null && vendor.max_tier !== null && vendor.default_tier > vendor.max_tier) {
    throw new ValidationError('"defaultTier" cannot be greater than "maxTier".');
  }

  return {
    vendor,
    capabilityIds: optionalIdArray(body.capabilityIds, "capabilityIds"),
    workloadIds: optionalIdArray(body.workloadIds, "workloadIds"),
  };
}

export function validateVendorPatchInput(body: unknown): VendorPatch {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }

  const patch: VendorPatch = {};
  if (body.slug !== undefined) patch.slug = requireSlug(body.slug, "slug");
  if (body.displayName !== undefined) patch.display_name = requireString(body.displayName, "displayName");
  if (body.vendorType !== undefined) patch.vendor_type = requireString(body.vendorType, "vendorType", { maxLength: 100 });
  if (body.protocol !== undefined) patch.protocol = requireString(body.protocol, "protocol", { maxLength: 100 });
  if (body.baseEndpoint !== undefined) patch.base_endpoint = requireHttpUrl(body.baseEndpoint, "baseEndpoint");
  if (body.description !== undefined) patch.description = optionalString(body.description, "description");
  if (body.status !== undefined) patch.status = requireStatus(body.status);
  if (body.billingType !== undefined) patch.billing_type = requireString(body.billingType, "billingType", { maxLength: 100 });
  if (body.defaultTier !== undefined) patch.default_tier = optionalNonNegativeInt(body.defaultTier, "defaultTier") ?? null;
  if (body.maxTier !== undefined) patch.max_tier = optionalNonNegativeInt(body.maxTier, "maxTier") ?? null;
  if (body.automaticFallback !== undefined) {
    patch.automatic_fallback = optionalBoolean(body.automaticFallback, "automaticFallback");
  }
  if (body.timeoutMs !== undefined) patch.timeout_ms = optionalNonNegativeInt(body.timeoutMs, "timeoutMs") ?? null;
  if (body.retryMaxAttempts !== undefined) {
    patch.retry_max_attempts = optionalNonNegativeInt(body.retryMaxAttempts, "retryMaxAttempts", { max: 20 }) ?? null;
  }
  if (body.retryBackoffMs !== undefined) {
    patch.retry_backoff_ms = optionalNonNegativeInt(body.retryBackoffMs, "retryBackoffMs") ?? null;
  }
  if (body.priority !== undefined) patch.priority = requireNonNegativeInt(body.priority, "priority", { max: 10 });
  if (body.retryOnTimeout !== undefined) patch.retry_on_timeout = optionalBoolean(body.retryOnTimeout, "retryOnTimeout");
  if (body.retryOnRateLimit !== undefined) {
    patch.retry_on_rate_limit = optionalBoolean(body.retryOnRateLimit, "retryOnRateLimit");
  }
  if (body.retryOn5xx !== undefined) patch.retry_on_5xx = optionalBoolean(body.retryOn5xx, "retryOn5xx");
  if (body.retryOnAuthFailure !== undefined) {
    patch.retry_on_auth_failure = optionalBoolean(body.retryOnAuthFailure, "retryOnAuthFailure");
  }
  if (body.retryOnInvalidResponse !== undefined) {
    patch.retry_on_invalid_response = optionalBoolean(body.retryOnInvalidResponse, "retryOnInvalidResponse");
  }

  if (
    patch.default_tier !== undefined &&
    patch.default_tier !== null &&
    patch.max_tier !== undefined &&
    patch.max_tier !== null &&
    patch.default_tier > patch.max_tier
  ) {
    throw new ValidationError('"defaultTier" cannot be greater than "maxTier".');
  }

  if (Object.keys(patch).length === 0) {
    throw new ValidationError("Request body must include at least one field to update.");
  }

  return patch;
}

export function validateCreateAccountInput(body: unknown): Omit<NewVendorAccount, "vendor_id"> {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  return {
    slug: requireSlug(body.slug, "slug"),
    display_name: requireString(body.displayName, "displayName"),
    status: requireStatus(body.status ?? "enabled"),
    external_account_ref: optionalString(body.externalAccountRef, "externalAccountRef", { maxLength: 500 }),
  };
}

export function validateAccountPatchInput(body: unknown): VendorAccountPatch {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  const patch: VendorAccountPatch = {};
  if (body.slug !== undefined) patch.slug = requireSlug(body.slug, "slug");
  if (body.displayName !== undefined) patch.display_name = requireString(body.displayName, "displayName");
  if (body.status !== undefined) patch.status = requireStatus(body.status);
  if (body.externalAccountRef !== undefined) {
    patch.external_account_ref = optionalString(body.externalAccountRef, "externalAccountRef", { maxLength: 500 });
  }
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("Request body must include at least one field to update.");
  }
  return patch;
}

const MAX_SECRET_LENGTH = 10_000;

/**
 * A credential's secret arrives one of two ways (see docs/CREDENTIAL_VAULT.md):
 * `secretRef` — a caller-supplied external reference, unchanged since
 * Block 06 — or `secret` — the actual raw provider secret, which the
 * service layer immediately encrypts via `CredentialVaultService` and
 * never persists in this shape. Exactly one must be provided; accepting
 * both would leave it ambiguous which mode the credential is in.
 */
export interface CreateCredentialInput {
  vendorAccountId: string;
  credential_type: string;
  secret_ref: string | null;
  secret: string | null;
  status: VendorStatus;
}

function requireExactlyOneSecretMode(body: Record<string, unknown>): void {
  const hasSecretRef = body.secretRef !== undefined;
  const hasSecret = body.secret !== undefined;
  if (hasSecretRef === hasSecret) {
    throw new ValidationError('Exactly one of "secret" or "secretRef" must be provided.');
  }
}

export function validateCreateCredentialInput(body: unknown): CreateCredentialInput {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  requireExactlyOneSecretMode(body);
  const hasSecret = body.secret !== undefined;
  return {
    vendorAccountId: requireUuidParam(body.vendorAccountId, "vendorAccountId"),
    credential_type: requireString(body.credentialType, "credentialType", { maxLength: 100 }),
    secret_ref: hasSecret ? null : requireString(body.secretRef, "secretRef", { maxLength: 500 }),
    secret: hasSecret ? requireString(body.secret, "secret", { maxLength: MAX_SECRET_LENGTH }) : null,
    status: requireStatus(body.status ?? "enabled"),
  };
}

/**
 * Distinct from `VendorCredentialPatch` (the repository-level shape, which
 * includes the encrypted columns) — this is the HTTP-facing shape. The
 * service layer translates `secret`/`secretRef` into the encrypted/ref
 * repository columns; neither the route nor this validator ever sees
 * ciphertext.
 */
export interface UpdateCredentialInput {
  credential_type?: string;
  secret_ref?: string;
  secret?: string;
  status?: VendorStatus;
}

export function validateCredentialPatchInput(body: unknown): UpdateCredentialInput {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  if (body.secretRef !== undefined && body.secret !== undefined) {
    throw new ValidationError('Provide at most one of "secret" or "secretRef" when rotating a credential.');
  }
  const patch: UpdateCredentialInput = {};
  if (body.credentialType !== undefined) {
    patch.credential_type = requireString(body.credentialType, "credentialType", { maxLength: 100 });
  }
  if (body.secretRef !== undefined) patch.secret_ref = requireString(body.secretRef, "secretRef", { maxLength: 500 });
  if (body.secret !== undefined) patch.secret = requireString(body.secret, "secret", { maxLength: MAX_SECRET_LENGTH });
  if (body.status !== undefined) patch.status = requireStatus(body.status);
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("Request body must include at least one field to update.");
  }
  return patch;
}

export function validateIdSetBody(body: unknown, field: string): string[] {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  const ids = optionalIdArray(body[field], field);
  if (ids === undefined) {
    throw new ValidationError(`"${field}" is required and must be an array of ID strings.`);
  }
  return ids;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuidParam(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ValidationError(`"${field}" must be a valid UUID.`);
  }
  return value;
}
