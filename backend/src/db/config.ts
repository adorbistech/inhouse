import type { DbConfig } from "../types/db.js";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable "${key}".`);
  }
  return value;
}

function parsePositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${key} "${raw}". Expected a positive integer.`);
  }
  return value;
}

function parseBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`Invalid ${key} "${raw}". Expected "true" or "false".`);
}

/**
 * Loads and validates Inhouse Postgres configuration from the environment.
 * Fails fast on any invalid value. The password has no default — a missing
 * value is a startup error, never a silently-applied default secret.
 */
export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    host: env.INHOUSE_DB_HOST ?? "inhouse-postgres",
    port: parsePositiveInt(env, "INHOUSE_DB_PORT", 5432),
    database: env.INHOUSE_DB_NAME ?? "inhouse",
    user: env.INHOUSE_DB_USER ?? "inhouse_app",
    password: required(env, "INHOUSE_DB_PASSWORD"),
    schema: env.INHOUSE_DB_SCHEMA ?? "inhouse",
    poolMin: parsePositiveInt(env, "INHOUSE_DB_POOL_MIN", 2),
    poolMax: parsePositiveInt(env, "INHOUSE_DB_POOL_MAX", 10),
    ssl: parseBoolean(env, "INHOUSE_DB_SSL", false),
  };
}
