import { ValidationError } from "../lib/httpErrors.js";

export const HEALTH_STATUSES = ["healthy", "degraded", "unhealthy"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const ERROR_CATEGORIES = [
  "authentication",
  "authorization",
  "rate_limit",
  "timeout",
  "network",
  "provider_error",
  "configuration",
  "unknown",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** `manual` — an operator/test triggered this. `adapter` — reserved for a future real provider adapter (Block 10+). */
export const HEALTH_SOURCES = ["manual", "adapter"] as const;
export type HealthSource = (typeof HEALTH_SOURCES)[number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ERROR_CODE_LENGTH = 100;
const MAX_LATENCY_MS = 10 * 60 * 1000; // 10 minutes — generously bounds a "sane" health-check latency.
const MAX_FUTURE_SKEW_MS = 60_000; // allow up to 60s of clock skew, never further "in the future" than that.
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireUuidParam(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ValidationError(`"${field}" must be a valid UUID.`);
  }
  return value;
}

function requireHealthStatus(value: unknown, field = "status"): HealthStatus {
  if (typeof value !== "string" || !HEALTH_STATUSES.includes(value as HealthStatus)) {
    throw new ValidationError(`"${field}" must be one of: ${HEALTH_STATUSES.join(", ")}.`);
  }
  return value as HealthStatus;
}

function requireHealthSource(value: unknown, field = "source"): HealthSource {
  if (typeof value !== "string" || !HEALTH_SOURCES.includes(value as HealthSource)) {
    throw new ValidationError(`"${field}" must be one of: ${HEALTH_SOURCES.join(", ")}.`);
  }
  return value as HealthSource;
}

function optionalErrorCategory(value: unknown, field = "errorCategory"): ErrorCategory | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !ERROR_CATEGORIES.includes(value as ErrorCategory)) {
    throw new ValidationError(`"${field}" must be one of: ${ERROR_CATEGORIES.join(", ")}.`);
  }
  return value as ErrorCategory;
}

function optionalLatencyMs(value: unknown, field = "latencyMs"): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ValidationError(`"${field}" must be an integer number of milliseconds.`);
  }
  if (value < 0) {
    throw new ValidationError(`"${field}" must not be negative.`);
  }
  if (value > MAX_LATENCY_MS) {
    throw new ValidationError(`"${field}" must be at most ${MAX_LATENCY_MS}ms.`);
  }
  return value;
}

function optionalSafeErrorCode(value: unknown, field = "safeErrorCode"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`"${field}" must be a non-empty string when provided.`);
  }
  if (value.length > MAX_ERROR_CODE_LENGTH) {
    throw new ValidationError(`"${field}" must be at most ${MAX_ERROR_CODE_LENGTH} characters.`);
  }
  return value;
}

function requireCheckedAt(value: unknown, field = "checkedAt"): Date {
  if (value === undefined) return new Date();
  const date = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`"${field}" must be a valid date/time.`);
  }
  if (date.getTime() > Date.now() + MAX_FUTURE_SKEW_MS) {
    throw new ValidationError(`"${field}" cannot be in the future.`);
  }
  return date;
}

export interface HealthObservationInput {
  status: HealthStatus;
  latencyMs: number | null;
  errorCategory: ErrorCategory | null;
  safeErrorCode: string | null;
  source: HealthSource;
  checkedAt: Date;
}

/**
 * Validates a health observation before it reaches
 * `ProviderHealthService.recordObservation()`. Not driven by an HTTP
 * body in Block 09 (there is no public write endpoint — see
 * docs/PROVIDER_HEALTH.md) but the boundary is still real: this is what
 * a future provider adapter's output must pass through, and what tests
 * exercise directly.
 */
export function validateHealthObservationInput(body: unknown): HealthObservationInput {
  if (!isPlainObject(body)) {
    throw new ValidationError("Health observation must be an object.");
  }
  const status = requireHealthStatus(body.status);
  const errorCategory = optionalErrorCategory(body.errorCategory);
  if (status === "healthy" && errorCategory !== null) {
    throw new ValidationError('"errorCategory" must not be set when status is "healthy".');
  }
  if (status !== "healthy" && errorCategory === null) {
    throw new ValidationError('"errorCategory" is required when status is not "healthy".');
  }
  return {
    status,
    latencyMs: optionalLatencyMs(body.latencyMs),
    errorCategory,
    safeErrorCode: optionalSafeErrorCode(body.safeErrorCode),
    source: requireHealthSource(body.source),
    checkedAt: requireCheckedAt(body.checkedAt),
  };
}

export interface HealthHistoryQuery {
  limit: number;
}

export function validateHealthHistoryQuery(query: Record<string, unknown>): HealthHistoryQuery {
  if (query.limit === undefined) {
    return { limit: DEFAULT_LIST_LIMIT };
  }
  const parsed = Number(query.limit);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIST_LIMIT) {
    throw new ValidationError(`"limit" must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
  }
  return { limit: parsed };
}
