import { ValidationError } from "../lib/httpErrors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireUuidParam(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ValidationError(`"${field}" must be a valid UUID.`);
  }
  return value;
}

const MAX_WORKLOAD_GRANTS = 100;

/**
 * `workloadIds` is the key's complete grant set: the workloads it may
 * execute against, default deny (a key can never use a workload not listed
 * here — see `services/executionService.ts`). Existence of each id is
 * checked by the route against the `workloads` table, not here.
 */
export function validateWorkloadIds(value: unknown, field = "workloadIds"): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`"${field}" must be an array of workload UUIDs.`);
  }
  if (value.length > MAX_WORKLOAD_GRANTS) {
    throw new ValidationError(`"${field}" must contain at most ${MAX_WORKLOAD_GRANTS} entries.`);
  }
  const ids = value.map((v, i) => requireUuidParam(v, `${field}[${i}]`));
  return [...new Set(ids)];
}

export interface CreateApiKeyInput {
  name: string;
  expiresAt: Date | null;
  workloadIds: string[];
}

export function validateCreateApiKeyInput(body: unknown): CreateApiKeyInput {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  const name = body.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ValidationError('"name" is required and must be a non-empty string.');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new ValidationError(`"name" must be at most ${MAX_NAME_LENGTH} characters.`);
  }

  const workloadIds = validateWorkloadIds(body.workloadIds);
  if (workloadIds.length === 0) {
    throw new ValidationError('"workloadIds" must list at least one workload the key may use.');
  }

  let expiresAt: Date | null = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    if (typeof body.expiresAt !== "string") {
      throw new ValidationError('"expiresAt" must be an ISO-8601 date string or null.');
    }
    const parsed = new Date(body.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError('"expiresAt" must be a valid ISO-8601 date string.');
    }
    expiresAt = parsed;
  }

  return { name: name.trim(), expiresAt, workloadIds };
}

export function validateSetWorkloadsInput(body: unknown): string[] {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  return validateWorkloadIds(body.workloadIds);
}
