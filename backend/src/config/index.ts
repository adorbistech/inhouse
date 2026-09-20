export type Environment = "development" | "test" | "staging" | "production";

export interface AppConfig {
  environment: Environment;
  host: string;
  port: number;
  logLevel: string;
  apiPrefix: string;
  bodyLimitBytes: number;
  corsAllowedOrigins: string[];
  /** Bearer token guarding the control-plane routes that mint/manage client keys and read telemetry. Null = those routes fail closed (503). */
  adminToken: string | null;
}

const ALLOWED_ENVIRONMENTS: Environment[] = ["development", "test", "staging", "production"];
const ALLOWED_LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

function parseEnvironment(value: string | undefined): Environment {
  const normalized = (value ?? "development").toLowerCase();
  if (!ALLOWED_ENVIRONMENTS.includes(normalized as Environment)) {
    throw new Error(
      `Invalid INHOUSE_API_ENV "${value}". Expected one of: ${ALLOWED_ENVIRONMENTS.join(", ")}`,
    );
  }
  return normalized as Environment;
}

function parsePort(value: string | undefined): number {
  const raw = value ?? "8092";
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid INHOUSE_API_PORT "${raw}". Expected an integer between 1 and 65535.`);
  }
  return port;
}

function parseLogLevel(value: string | undefined): string {
  const level = (value ?? "info").toLowerCase();
  if (!ALLOWED_LOG_LEVELS.includes(level)) {
    throw new Error(
      `Invalid INHOUSE_API_LOG_LEVEL "${value}". Expected one of: ${ALLOWED_LOG_LEVELS.join(", ")}`,
    );
  }
  return level;
}

function parseBodyLimit(value: string | undefined): number {
  const raw = value ?? "1048576";
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid INHOUSE_API_BODY_LIMIT "${raw}". Expected a positive integer (bytes).`);
  }
  return limit;
}

function parseCorsOrigins(value: string | undefined): string[] {
  if (!value || value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

const MIN_ADMIN_TOKEN_LENGTH = 32;

function parseAdminToken(value: string | undefined, environment: Environment): string | null {
  const token = value?.trim();
  if (!token) {
    if (environment === "production" || environment === "staging") {
      throw new Error(
        "INHOUSE_ADMIN_TOKEN is required in production/staging (it guards every control-plane route). " +
          "Generate one with: openssl rand -hex 32",
      );
    }
    return null;
  }
  if (token.length < MIN_ADMIN_TOKEN_LENGTH) {
    throw new Error(`INHOUSE_ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters.`);
  }
  return token;
}

/**
 * Loads and validates process environment into a typed config. Throws on any
 * invalid value so misconfiguration fails fast at startup rather than
 * producing undefined runtime behavior.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = parseEnvironment(env.INHOUSE_API_ENV ?? env.NODE_ENV);
  return {
    environment,
    // Loopback by default: exposing the API beyond the host is an explicit,
    // deliberate deployment decision (docker-compose sets it for the container).
    host: env.INHOUSE_API_HOST ?? "127.0.0.1",
    port: parsePort(env.INHOUSE_API_PORT),
    logLevel: parseLogLevel(env.INHOUSE_API_LOG_LEVEL),
    apiPrefix: env.INHOUSE_API_PREFIX ?? "/v1",
    bodyLimitBytes: parseBodyLimit(env.INHOUSE_API_BODY_LIMIT),
    corsAllowedOrigins: parseCorsOrigins(env.INHOUSE_API_CORS_ORIGINS),
    adminToken: parseAdminToken(env.INHOUSE_ADMIN_TOKEN, environment),
  };
}
