import { ValidationError } from "../lib/httpErrors.js";
import type { ModelPatch, NewModel } from "../repositories/types.js";

export const MODEL_STATUSES = ["enabled", "disabled"] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

const ALIAS_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONTEXT_WINDOW = 10_000_000;
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

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

function requireAlias(value: unknown, field: string): string {
  const str = requireString(value, field, { maxLength: 150 });
  if (!ALIAS_PATTERN.test(str)) {
    throw new ValidationError(
      `"${field}" must be a lowercase, dash-separated identifier (e.g. "my-model-alias").`,
    );
  }
  return str;
}

function requireModelStatus(value: unknown, field = "status"): ModelStatus {
  const str = requireString(value, field, { maxLength: 20 });
  if (!MODEL_STATUSES.includes(str as ModelStatus)) {
    throw new ValidationError(`"${field}" must be one of: ${MODEL_STATUSES.join(", ")}.`);
  }
  return str as ModelStatus;
}

function optionalNonNegativeInt(value: unknown, field: string, { max }: { max?: number } = {}): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`"${field}" must be a non-negative integer.`);
  }
  if (max !== undefined && value > max) {
    throw new ValidationError(`"${field}" must be at most ${max}.`);
  }
  return value;
}

function optionalIdArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.length > 0)) {
    throw new ValidationError(`"${field}" must be an array of ID strings.`);
  }
  return value;
}

export function requireUuidParam(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ValidationError(`"${field}" must be a valid UUID.`);
  }
  return value;
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

export interface CreateModelInput {
  vendorId: string;
  model: Omit<NewModel, "vendor_id">;
  capabilityIds?: string[];
  workloadIds?: string[];
}

export function validateCreateModelInput(body: unknown): CreateModelInput {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }

  const vendorId = requireUuidParam(body.vendorId, "vendorId");
  const model: Omit<NewModel, "vendor_id"> = {
    provider_model_id: requireString(body.providerModelId, "providerModelId", { maxLength: 300 }),
    inhouse_alias: requireAlias(body.inhouseAlias, "inhouseAlias"),
    display_name: requireString(body.displayName, "displayName"),
    context_window: optionalNonNegativeInt(body.contextWindow, "contextWindow", { max: MAX_CONTEXT_WINDOW }) ?? null,
    status: requireModelStatus(body.status ?? "enabled"),
  };

  return {
    vendorId,
    model,
    capabilityIds: optionalIdArray(body.capabilityIds, "capabilityIds"),
    workloadIds: optionalIdArray(body.workloadIds, "workloadIds"),
  };
}

export function validateModelPatchInput(body: unknown): ModelPatch {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  if (body.vendorId !== undefined) {
    throw new ValidationError('"vendorId" cannot be changed after a model is created.');
  }

  const patch: ModelPatch = {};
  if (body.providerModelId !== undefined) {
    patch.provider_model_id = requireString(body.providerModelId, "providerModelId", { maxLength: 300 });
  }
  if (body.inhouseAlias !== undefined) patch.inhouse_alias = requireAlias(body.inhouseAlias, "inhouseAlias");
  if (body.displayName !== undefined) patch.display_name = requireString(body.displayName, "displayName");
  if (body.contextWindow !== undefined) {
    patch.context_window = optionalNonNegativeInt(body.contextWindow, "contextWindow", { max: MAX_CONTEXT_WINDOW }) ?? null;
  }
  if (body.status !== undefined) patch.status = requireModelStatus(body.status);

  if (Object.keys(patch).length === 0) {
    throw new ValidationError("Request body must include at least one field to update.");
  }

  return patch;
}

export interface ModelListQuery {
  vendorId?: string;
  status?: string;
  capabilityId?: string;
  workloadId?: string;
  search?: string;
  limit: number;
  offset: number;
}

/** Query-string values arrive as strings (or undefined) — validated the same way regardless of source. */
export function validateModelListQuery(query: Record<string, unknown>): ModelListQuery {
  const result: ModelListQuery = { limit: DEFAULT_LIST_LIMIT, offset: 0 };

  if (query.vendorId !== undefined) result.vendorId = requireUuidParam(query.vendorId, "vendorId");
  if (query.capabilityId !== undefined) result.capabilityId = requireUuidParam(query.capabilityId, "capabilityId");
  if (query.workloadId !== undefined) result.workloadId = requireUuidParam(query.workloadId, "workloadId");
  if (query.status !== undefined) result.status = requireModelStatus(query.status, "status");
  if (query.search !== undefined) {
    result.search = requireString(query.search, "search", { maxLength: 200 });
  }
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIST_LIMIT) {
      throw new ValidationError(`"limit" must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
    }
    result.limit = parsed;
  }
  if (query.offset !== undefined) {
    const parsed = Number(query.offset);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new ValidationError('"offset" must be a non-negative integer.');
    }
    result.offset = parsed;
  }

  return result;
}
