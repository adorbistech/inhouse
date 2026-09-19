import type {
  NormalizedProviderRequest,
  NormalizedProviderResponse,
  ProviderAdapter,
  ProviderAdapterConfig,
  ProviderExecutionResult,
  ProviderHealthCheckResult,
} from "../providerAdapter.js";
import {
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  categorizeExecutionHttpStatus,
  categorizeHealthHttpStatus,
  isAbortError,
  readBoundedResponseText,
  safeNetworkErrorCode,
  trimTrailingSlash,
} from "./httpErrorMapping.js";

/**
 * The subset of the global `fetch` signature this adapter depends on.
 * Injectable so tests exercise real timeout/JSON-parsing/error-mapping
 * behavior against a deterministic transport stub — never a real provider
 * (see docs/PROVIDER_ADAPTERS.md, "Testing"). Defaults to the platform's
 * global `fetch` (Node 18+), so production code adds no new dependency.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the OpenAI-compatible wire-format chat-completions body from a
 * normalized request. Pure translation — no vendor/business knowledge, no
 * business-provider-specific fields.
 */
function translateRequest(request: NormalizedProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: request.stream,
  };
  if (request.maxOutputTokens !== null) body.max_tokens = request.maxOutputTokens;
  if (request.temperature !== null) body.temperature = request.temperature;
  return body;
}

/** Returns `null` (never throws) when the shape isn't what's expected — the caller treats that as a normalization failure. */
function normalizeResponseBody(json: unknown, latencyMs: number): NormalizedProviderResponse | null {
  if (!isPlainObject(json)) return null;
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (!isPlainObject(first)) return null;
  const message = first.message;
  const content = isPlainObject(message) && typeof message.content === "string" ? message.content : null;
  if (content === null) return null;

  const usage = isPlainObject(json.usage) ? json.usage : null;
  return {
    providerRequestId: typeof json.id === "string" ? json.id : null,
    model: typeof json.model === "string" ? json.model : "unknown",
    output: content,
    finishReason: typeof first.finish_reason === "string" ? first.finish_reason : null,
    usage: {
      inputTokens: usage && typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
      outputTokens: usage && typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
      totalTokens: usage && typeof usage.total_tokens === "number" ? usage.total_tokens : null,
    },
    latencyMs,
  };
}

/**
 * Protocol adapter for OpenAI-compatible APIs (standard `/models` and
 * `/chat/completions` endpoints, Bearer-token authentication). A
 * *protocol*, not a business provider: any number of database-configured
 * vendors sharing this protocol reuse this single adapter instance, each
 * with its own `baseEndpoint`/credential (see `adapterRegistry.ts`). No
 * `api.openai.com`, no OpenAI-specific business rule, no OpenAI pricing —
 * everything provider-specific comes from `config`/`secret`, supplied by
 * the caller from database configuration and the Block 08 credential
 * vault, never hardcoded here.
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly protocol = "openai-compatible";

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async checkHealth(secret: string, config: ProviderAdapterConfig): Promise<ProviderHealthCheckResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await this.fetchImpl(`${trimTrailingSlash(config.baseEndpoint)}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${secret}` },
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;
      if (res.ok) {
        return { status: "healthy", latencyMs, errorCategory: null, safeErrorCode: null };
      }
      return {
        status: "unhealthy",
        latencyMs,
        errorCategory: categorizeHealthHttpStatus(res.status),
        safeErrorCode: String(res.status),
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      if (isAbortError(error)) {
        return { status: "unhealthy", latencyMs, errorCategory: "timeout", safeErrorCode: "ETIMEDOUT" };
      }
      return { status: "unhealthy", latencyMs, errorCategory: "network", safeErrorCode: safeNetworkErrorCode(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(
    secret: string,
    config: ProviderAdapterConfig,
    request: NormalizedProviderRequest,
  ): Promise<ProviderExecutionResult> {
    const body = JSON.stringify(translateRequest(request));
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
      return {
        ok: false,
        error: { category: "invalid_request", safeErrorCode: null, message: "Request body exceeds the maximum allowed size." },
      };
    }

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await this.fetchImpl(`${trimTrailingSlash(config.baseEndpoint)}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;

      if (!res.ok) {
        return {
          ok: false,
          error: {
            category: categorizeExecutionHttpStatus(res.status),
            safeErrorCode: String(res.status),
            message: `Provider responded with HTTP ${res.status}.`,
          },
        };
      }

      const text = await readBoundedResponseText(res, MAX_RESPONSE_BODY_BYTES);
      if (text === null) {
        return {
          ok: false,
          error: { category: "provider_error", safeErrorCode: null, message: "Provider response exceeded the maximum allowed size." },
        };
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return {
          ok: false,
          error: { category: "provider_error", safeErrorCode: null, message: "Provider response was not valid JSON." },
        };
      }

      const normalized = normalizeResponseBody(json, latencyMs);
      if (!normalized) {
        return {
          ok: false,
          error: { category: "provider_error", safeErrorCode: null, message: "Provider response was missing required fields." },
        };
      }
      return { ok: true, response: normalized };
    } catch (error) {
      const latencyMs = Date.now() - start;
      if (isAbortError(error)) {
        return {
          ok: false,
          error: { category: "timeout", safeErrorCode: "ETIMEDOUT", message: `Request to provider timed out after ${latencyMs}ms.` },
        };
      }
      return {
        ok: false,
        error: { category: "network", safeErrorCode: safeNetworkErrorCode(error), message: "Network error contacting provider." },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
