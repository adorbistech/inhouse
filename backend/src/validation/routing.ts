import { ValidationError } from "../lib/httpErrors.js";
import type { RoutingFallbackRulePatch, RoutingTierPatch } from "../repositories/types.js";

/**
 * The fixed vocabulary a `routing_fallback_rules.condition_type` may use.
 * Deliberately mirrors the per-condition retry flags Block 06 already
 * added to `vendors` (`retry_on_timeout`, `retry_on_rate_limit`, etc.) so
 * the two vocabularies never drift apart — see docs/ROUTING_POLICY.md,
 * "Fallback Rules Are Data, Not an Engine". Block 11 only validates and
 * displays these; nothing evaluates them to actually trigger a fallback.
 */
export const FALLBACK_CONDITION_TYPES = [
  "on_error",
  "on_timeout",
  "on_rate_limit",
  "on_5xx",
  "on_auth_failure",
  "on_invalid_response",
] as const;
export type FallbackConditionType = (typeof FALLBACK_CONDITION_TYPES)[number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TIER_NUMBER = 1000;
const MAX_PRIORITY = 1000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 20;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireUuidParam(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ValidationError(`"${field}" must be a valid UUID.`);
  }
  return value;
}

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireUuidParam(value, field);
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

function optionalPositiveInt(value: unknown, field: string, { max }: { max?: number } = {}): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`"${field}" must be a positive integer.`);
  }
  if (max !== undefined && value > max) {
    throw new ValidationError(`"${field}" must be at most ${max}.`);
  }
  return value;
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

function requireConditionType(value: unknown, field = "conditionType"): FallbackConditionType {
  if (typeof value !== "string" || !FALLBACK_CONDITION_TYPES.includes(value as FallbackConditionType)) {
    throw new ValidationError(`"${field}" must be one of: ${FALLBACK_CONDITION_TYPES.join(", ")}.`);
  }
  return value as FallbackConditionType;
}

function optionalConditionConfig(value: unknown, field = "conditionConfig"): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new ValidationError(`"${field}" must be a JSON object.`);
  }
  return value;
}

function optionalIdArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.length > 0)) {
    throw new ValidationError(`"${field}" must be an array of ID strings.`);
  }
  for (const id of value) {
    requireUuidParam(id, field);
  }
  return value;
}

export interface CreateRoutingTierInput {
  vendorId: string;
  modelId: string;
  tierNumber: number;
  priority: number;
  enabled: boolean;
  timeoutOverrideMs: number | null;
  maxAttempts: number | null;
}

export function validateCreateRoutingTierInput(body: unknown): CreateRoutingTierInput {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  return {
    vendorId: requireUuidParam(body.vendorId, "vendorId"),
    modelId: requireUuidParam(body.modelId, "modelId"),
    tierNumber: requireNonNegativeInt(body.tierNumber, "tierNumber", { max: MAX_TIER_NUMBER }),
    priority: requireNonNegativeInt(body.priority ?? 0, "priority", { max: MAX_PRIORITY }),
    enabled: requireBoolean(body.enabled, "enabled", true),
    timeoutOverrideMs: optionalPositiveInt(body.timeoutOverrideMs, "timeoutOverrideMs", { max: MAX_TIMEOUT_MS }) ?? null,
    maxAttempts: optionalPositiveInt(body.maxAttempts, "maxAttempts", { max: MAX_ATTEMPTS }) ?? null,
  };
}

export function validateRoutingTierPatchInput(body: unknown): RoutingTierPatch {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  const patch: RoutingTierPatch = {};
  if (body.priority !== undefined) patch.priority = requireNonNegativeInt(body.priority, "priority", { max: MAX_PRIORITY });
  if (body.enabled !== undefined) patch.enabled = optionalBoolean(body.enabled, "enabled");
  if (body.timeoutOverrideMs !== undefined) {
    patch.timeout_override_ms = optionalPositiveInt(body.timeoutOverrideMs, "timeoutOverrideMs", { max: MAX_TIMEOUT_MS }) ?? null;
  }
  if (body.maxAttempts !== undefined) {
    patch.max_attempts = optionalPositiveInt(body.maxAttempts, "maxAttempts", { max: MAX_ATTEMPTS }) ?? null;
  }
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("Request body must include at least one field to update.");
  }
  return patch;
}

export interface CreateRoutingFallbackRuleInput {
  fromTierId: string;
  toTierId: string;
  conditionType: FallbackConditionType;
  conditionConfig: Record<string, unknown>;
  priority: number;
  enabled: boolean;
}

export function validateCreateRoutingFallbackRuleInput(body: unknown): CreateRoutingFallbackRuleInput {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  const fromTierId = requireUuidParam(body.fromTierId, "fromTierId");
  const toTierId = requireUuidParam(body.toTierId, "toTierId");
  if (fromTierId === toTierId) {
    throw new ValidationError('"fromTierId" and "toTierId" must reference different tiers.');
  }
  return {
    fromTierId,
    toTierId,
    conditionType: requireConditionType(body.conditionType),
    conditionConfig: optionalConditionConfig(body.conditionConfig),
    priority: requireNonNegativeInt(body.priority ?? 0, "priority", { max: MAX_PRIORITY }),
    enabled: requireBoolean(body.enabled, "enabled", true),
  };
}

export function validateRoutingFallbackRulePatchInput(body: unknown): RoutingFallbackRulePatch {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  const patch: RoutingFallbackRulePatch = {};
  if (body.conditionType !== undefined) patch.condition_type = requireConditionType(body.conditionType);
  if (body.conditionConfig !== undefined) patch.condition_config = optionalConditionConfig(body.conditionConfig);
  if (body.priority !== undefined) patch.priority = requireNonNegativeInt(body.priority, "priority", { max: MAX_PRIORITY });
  if (body.enabled !== undefined) patch.enabled = optionalBoolean(body.enabled, "enabled");
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("Request body must include at least one field to update.");
  }
  return patch;
}

export interface RoutingPreviewInput {
  workloadId: string;
  modelId?: string;
  capabilityIds?: string[];
}

/**
 * Validates a dry-run/preview request. Deliberately accepts only database
 * IDs (`workloadId`/`modelId`/`capabilityIds`) — never a provider name, an
 * outbound header, or a credential (see docs/ROUTING_POLICY.md, "Preview
 * Input Is Never Business/Provider-Shaped").
 */
export function validateRoutingPreviewInput(body: unknown): RoutingPreviewInput {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  return {
    workloadId: requireUuidParam(body.workloadId, "workloadId"),
    modelId: optionalUuid(body.modelId, "modelId"),
    capabilityIds: optionalIdArray(body.capabilityIds, "capabilityIds"),
  };
}
