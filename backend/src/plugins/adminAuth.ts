import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "../config/index.js";
import { ServiceUnavailableError, UnauthorizedError } from "../lib/httpErrors.js";
import { extractBearerToken } from "../services/apiKeyAuthService.js";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * The control-plane (administrative) authentication boundary — separate
 * from, and never interchangeable with, either a client execution key
 * (`services/apiKeyAuthService.ts`) or a provider credential (Block 08).
 * The expected token comes only from `INHOUSE_ADMIN_TOKEN`
 * (`config/index.ts`); nothing is hardcoded and nothing is stored in the
 * database. Comparison is constant-time over fixed-length SHA-256 digests,
 * so neither the token's length nor any prefix leaks through timing. When
 * no token is configured the guard fails *closed* (503) rather than
 * letting the route through. Every rejection is the same uniform 401 — the
 * response never says whether the presented value looked like a client key.
 * The presented token is never logged (the `authorization` header is
 * already redacted by the logger) and never echoed.
 */
export function createAdminGuard(config: AppConfig): (request: FastifyRequest) => Promise<void> {
  const expected = config.adminToken ? digest(config.adminToken) : null;
  return async (request) => {
    if (!expected) {
      throw new ServiceUnavailableError(
        "ADMIN_AUTH_NOT_CONFIGURED",
        "Administrative authentication is not configured on this server.",
      );
    }
    const presented = extractBearerToken(request.headers.authorization);
    if (!presented || !timingSafeEqual(digest(presented), expected)) {
      throw new UnauthorizedError("Missing or invalid administrative credential.");
    }
  };
}

/**
 * Puts every route registered in this (encapsulated) Fastify scope behind
 * the administrative token. Runs at `onRequest`, so an unauthenticated
 * caller is rejected before body parsing or validation. Control-plane route
 * modules call this once at the top of their `app.register` scope instead of
 * wiring the guard route by route; the health/readiness and execution scopes
 * never call it.
 */
export function requireAdmin(scope: FastifyInstance, config: AppConfig): void {
  scope.addHook("onRequest", createAdminGuard(config));
}
