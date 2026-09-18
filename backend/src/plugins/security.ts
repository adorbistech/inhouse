import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config/index.js";

/**
 * Foundational, pre-authentication protections only: security headers and a
 * strict, environment-driven CORS allowlist. No production origins are
 * assumed — an empty allowlist disables cross-origin access entirely.
 */
export async function registerSecurity(app: FastifyInstance, config: AppConfig): Promise<void> {
  await app.register(helmet, { global: true });

  await app.register(cors, {
    origin: config.corsAllowedOrigins.length > 0 ? config.corsAllowedOrigins : false,
  });
}
