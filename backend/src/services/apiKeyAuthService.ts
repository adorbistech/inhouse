import type { Pool } from "pg";
import { UnauthorizedError } from "../lib/httpErrors.js";
import { ApiKeysRepository } from "../repositories/apiKeysRepository.js";
import type { InhouseApiKeyRow } from "../repositories/types.js";

/**
 * The one path in this codebase that authenticates an Inhouse-issued
 * client API key (never a provider credential — see
 * `services/credentialSecretAccess.ts` for that separate, provider-facing
 * boundary). Deliberately narrow: only the execution endpoints
 * (`routes/execution.ts`) call this. Control-plane routes are guarded by a
 * different, non-interchangeable credential (`plugins/adminAuth.ts`); this
 * only authenticates *execution* callers.
 *
 * The raw key is never logged here or anywhere it flows from — only
 * `key_id` (a separate, non-secret display identifier) ever appears in a
 * log line or error.
 */
export function extractBearerToken(authorizationHeader: string | string[] | undefined): string | null {
  const header = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function extractApiKeyHeader(apiKeyHeader: string | string[] | undefined): string | null {
  const header = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  const trimmed = header?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Validates the caller's Inhouse key against `inhouse_api_keys` and
 * returns the authenticated key row. Accepts the token from either
 * `Authorization: Bearer <key>` (OpenAI-compatible convention) or
 * `x-api-key: <key>` (the Anthropic SDK/Claude Code convention — neither
 * sends the other by default, so both are checked, not just one) — the
 * body field wins if a caller somehow sends both. Throws
 * `UnauthorizedError` (401) for every failure mode — missing header,
 * unknown key, disabled/revoked key, or an expired key — deliberately
 * without distinguishing *which* one in the response, exactly like a
 * disabled provider credential is refused without detail (see
 * `credentialSecretAccess.ts`): an attacker probing for valid-but-disabled
 * keys learns nothing from the response shape.
 */
export async function authenticateApiKey(
  pool: Pool,
  authorizationHeader: string | string[] | undefined,
  apiKeyHeader?: string | string[] | undefined,
): Promise<InhouseApiKeyRow> {
  const token = extractBearerToken(authorizationHeader) ?? extractApiKeyHeader(apiKeyHeader);
  if (!token) {
    throw new UnauthorizedError();
  }

  const repo = new ApiKeysRepository(pool);
  const row = await repo.findByRawKey(token);
  if (!row) {
    throw new UnauthorizedError();
  }
  if (row.status !== "active") {
    throw new UnauthorizedError();
  }
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
    throw new UnauthorizedError();
  }

  await repo.markUsed(row.id);
  return row;
}
