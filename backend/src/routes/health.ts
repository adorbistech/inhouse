import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config/index.js";

interface HealthResponse {
  status: "ok";
  service: string;
  platform: "INHOUSE";
  environment: string;
  timestamp: string;
}

interface ReadyResponse {
  status: "ready";
  service: string;
  timestamp: string;
}

function buildHealthResponse(config: AppConfig): HealthResponse {
  return {
    status: "ok",
    service: "inhouse-api",
    platform: "INHOUSE",
    environment: config.environment,
    timestamp: new Date().toISOString(),
  };
}

function buildReadyResponse(): ReadyResponse {
  // Deterministic by design: no database, cache, or provider dependency
  // exists yet, so readiness cannot depend on any of them. This will grow
  // real dependency checks in the block that introduces them.
  return {
    status: "ready",
    service: "inhouse-api",
    timestamp: new Date().toISOString(),
  };
}

/**
 * Registers both the unversioned liveness surface (/health, /ready — for
 * infra probes such as the Docker healthcheck) and the versioned API
 * contract surface (/v1/health, /v1/ready) under config.apiPrefix.
 */
export function registerHealthRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get("/health", async () => buildHealthResponse(config));
  app.get("/ready", async () => buildReadyResponse());

  app.register(
    async (versioned) => {
      versioned.get("/health", async () => buildHealthResponse(config));
      versioned.get("/ready", async () => buildReadyResponse());
    },
    { prefix: config.apiPrefix },
  );
}
