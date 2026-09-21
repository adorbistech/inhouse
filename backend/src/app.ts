import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "./config/index.js";
import type { CredentialVaultService } from "./lib/credentialVault.js";
import { registerErrorHandling } from "./plugins/errorHandler.js";
import { registerRequestContext } from "./plugins/requestContext.js";
import { registerSecurity } from "./plugins/security.js";
import type { AdapterRegistry } from "./services/adapters/adapterRegistry.js";
import { registerApiKeyRoutes } from "./routes/apiKeys.js";
import { registerCapabilityRoutes } from "./routes/capabilities.js";
import { registerExecutionRoutes } from "./routes/execution.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerProviderHealthRoutes } from "./routes/providerHealth.js";
import { registerRoutingRoutes } from "./routes/routing.js";
import { registerVendorRoutes } from "./routes/vendors.js";
import { registerWorkloadRoutes } from "./routes/workloads.js";

export interface BuildAppOptions {
  /** Override the logger's output stream. Used by tests to capture log lines. */
  loggerStream?: NodeJS.WritableStream;
  /** Override the provider-adapter registry. Used by tests to inject a spy/fake transport; defaults to the real registry. */
  adapterRegistry?: AdapterRegistry;
  /**
   * Postgres pool for Block 06+ data-backed routes (vendors, capabilities,
   * workloads). Optional and intentionally separate from `/health`/`/ready`
   * (see routes/health.ts) — those never depend on the database. Tests that
   * only exercise the Block 04 HTTP contract can keep calling `buildApp`
   * without a pool and never touch Postgres.
   */
  pool?: Pool;
  /**
   * Block 08 credential vault. Required whenever `pool` is provided — the
   * Vendor System's credential routes always need it, so `buildApp` fails
   * fast at construction time rather than deep inside a request if it's
   * missing (see lib/credentialVault.ts).
   */
  credentialVault?: CredentialVaultService;
}

/** Longest/safest caller-supplied `x-request-id` accepted verbatim. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  "res.headers['set-cookie']",
  "req.body.password",
  "req.body.token",
  "req.body.apiKey",
  "req.body.secret",
];

/**
 * Builds (but does not start) the Inhouse API Fastify instance. Kept
 * separate from server.ts so tests can exercise routes via `.inject()`
 * without binding a real port.
 */
export async function buildApp(config: AppConfig, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: config.bodyLimitBytes,
    genReqId: (request) => {
      const incoming = request.headers["x-request-id"];
      // A caller-supplied correlation id is honored only if it is short and
      // made of safe characters; anything else (oversized, control
      // characters, header/log-injection attempts) is replaced by a fresh id.
      if (typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming)) {
        return incoming;
      }
      return randomUUID();
    },
    logger: {
      level: config.logLevel,
      stream: options.loggerStream,
      redact: {
        paths: REDACTED_PATHS,
        censor: "[Redacted]",
      },
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            headers: request.headers,
          };
        },
        res(reply) {
          return {
            statusCode: reply.statusCode,
          };
        },
      },
    },
  });

  registerRequestContext(app);
  registerErrorHandling(app);
  await registerSecurity(app, config);
  registerHealthRoutes(app, config);

  if (options.pool) {
    if (!options.credentialVault) {
      throw new Error(
        "buildApp: options.credentialVault is required whenever options.pool is provided (see src/lib/credentialVault.ts).",
      );
    }
    registerVendorRoutes(app, options.pool, config, options.credentialVault);
    registerCapabilityRoutes(app, options.pool, config);
    registerWorkloadRoutes(app, options.pool, config);
    registerModelRoutes(app, options.pool, config);
    registerProviderHealthRoutes(app, options.pool, config, options.credentialVault, options.adapterRegistry);
    registerRoutingRoutes(app, options.pool, config);
    registerApiKeyRoutes(app, options.pool, config);
    registerExecutionRoutes(app, options.pool, config, options.credentialVault, options.adapterRegistry);
  }

  return app;
}
