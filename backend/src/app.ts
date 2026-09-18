import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config/index.js";
import { registerErrorHandling } from "./plugins/errorHandler.js";
import { registerRequestContext } from "./plugins/requestContext.js";
import { registerSecurity } from "./plugins/security.js";
import { registerHealthRoutes } from "./routes/health.js";

export interface BuildAppOptions {
  /** Override the logger's output stream. Used by tests to capture log lines. */
  loggerStream?: NodeJS.WritableStream;
}

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
      if (typeof incoming === "string" && incoming.trim().length > 0) {
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

  return app;
}
