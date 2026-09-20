import type {
  NormalizedFinishReason,
  NormalizedProviderError,
  NormalizedProviderMessage,
  NormalizedProviderRequest,
  NormalizedProviderResponse,
  NormalizedProviderUsage,
  NormalizedStreamEvent,
  NormalizedToolCall,
  ProviderAdapter,
  ProviderAdapterConfig,
  ProviderExecutionResult,
  ProviderHealthCheckResult,
  ProviderStreamResult,
} from "../providerAdapter.js";
import {
  AbortScope,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  MAX_STREAM_BYTES,
  MAX_STREAM_DURATION_MS,
  StreamLimitError,
  categorizeExecutionHttpStatus,
  categorizeHealthHttpStatus,
  isAbortError,
  readBoundedResponseText,
  readSseData,
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

function translateMessage(m: NormalizedProviderMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content.length > 0 ? m.content : null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

/**
 * Builds the OpenAI-compatible wire-format chat-completions body from a
 * normalized request. Pure translation — no vendor/business knowledge, no
 * business-provider-specific fields.
 */
function translateRequest(request: NormalizedProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(translateMessage),
    stream: request.stream,
  };
  if (request.maxOutputTokens !== null) body.max_tokens = request.maxOutputTokens;
  if (request.temperature !== null) body.temperature = request.temperature;
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, ...(t.description !== null ? { description: t.description } : {}), parameters: t.inputSchema },
    }));
    const choice = request.toolChoice;
    if (choice === "auto" || choice === "none" || choice === "required") body.tool_choice = choice;
    else if (choice) body.tool_choice = { type: "function", function: { name: choice.name } };
  }
  return body;
}

/** Maps this protocol's `finish_reason` strings onto the normalized set — unknown values become `"other"`, never leak through. */
function mapFinishReason(value: unknown): NormalizedFinishReason | null {
  if (typeof value !== "string") return null;
  switch (value) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

function normalizeUsage(raw: unknown): NormalizedProviderUsage {
  const usage = isPlainObject(raw) ? raw : null;
  return {
    inputTokens: usage && typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
    outputTokens: usage && typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
    totalTokens: usage && typeof usage.total_tokens === "number" ? usage.total_tokens : null,
  };
}

/** Returns `null` when any tool call is structurally invalid — the caller treats the whole response as malformed. */
function normalizeToolCalls(raw: unknown): NormalizedToolCall[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const calls: NormalizedToolCall[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry) || !isPlainObject(entry.function)) return null;
    const { id } = entry;
    const { name, arguments: args } = entry.function;
    if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) return null;
    if (typeof args !== "string") return null;
    calls.push({ id, name, arguments: args });
  }
  return calls;
}

/** Returns `null` (never throws) when the shape isn't what's expected — the caller treats that as a normalization failure. */
function normalizeResponseBody(json: unknown, latencyMs: number): NormalizedProviderResponse | null {
  if (!isPlainObject(json)) return null;
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (!isPlainObject(first)) return null;
  const message = first.message;
  if (!isPlainObject(message)) return null;
  const toolCalls = normalizeToolCalls(message.tool_calls);
  if (toolCalls === null) return null;
  const content = typeof message.content === "string" ? message.content : toolCalls.length > 0 ? "" : null;
  if (content === null) return null;

  return {
    providerRequestId: typeof json.id === "string" ? json.id : null,
    model: typeof json.model === "string" ? json.model : "unknown",
    output: content,
    toolCalls,
    finishReason: mapFinishReason(first.finish_reason),
    usage: normalizeUsage(json.usage),
    latencyMs,
  };
}

function abortedError(scope: AbortScope, latencyMs: number): NormalizedProviderError {
  if (scope.abortReason === "cancelled") {
    return { category: "cancelled", safeErrorCode: null, message: "The request was cancelled by the caller." };
  }
  return { category: "timeout", safeErrorCode: "ETIMEDOUT", message: `Request to provider timed out after ${latencyMs}ms.` };
}

function thrownError(error: unknown, scope: AbortScope, latencyMs: number): NormalizedProviderError {
  if (isAbortError(error) || scope.abortReason !== null) return abortedError(scope, latencyMs);
  if (error instanceof StreamLimitError) {
    return { category: "provider_error", safeErrorCode: null, message: "Provider response exceeded the maximum allowed size." };
  }
  return { category: "network", safeErrorCode: safeNetworkErrorCode(error), message: "Network error contacting provider." };
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
    signal?: AbortSignal,
  ): Promise<ProviderExecutionResult> {
    const body = JSON.stringify(translateRequest({ ...request, stream: false }));
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
      return {
        ok: false,
        error: { category: "invalid_request", safeErrorCode: null, message: "Request body exceeds the maximum allowed size." },
      };
    }

    const start = Date.now();
    const scope = new AbortScope(signal, config.timeoutMs);
    try {
      const res = await this.fetchImpl(`${trimTrailingSlash(config.baseEndpoint)}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body,
        signal: scope.signal,
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
      return { ok: false, error: thrownError(error, scope, Date.now() - start) };
    } finally {
      scope.dispose();
    }
  }

  async executeStream(
    secret: string,
    config: ProviderAdapterConfig,
    request: NormalizedProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProviderStreamResult> {
    const body = JSON.stringify({
      ...translateRequest({ ...request, stream: true }),
      stream_options: { include_usage: true },
    });
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
      return {
        ok: false,
        error: { category: "invalid_request", safeErrorCode: null, message: "Request body exceeds the maximum allowed size." },
      };
    }

    const start = Date.now();
    const scope = new AbortScope(signal, config.timeoutMs, MAX_STREAM_DURATION_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(`${trimTrailingSlash(config.baseEndpoint)}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body,
        signal: scope.signal,
      });
    } catch (error) {
      scope.dispose();
      return { ok: false, error: thrownError(error, scope, Date.now() - start) };
    }
    const latencyMs = Date.now() - start;

    if (!res.ok || !res.body) {
      scope.abort("cancelled");
      scope.dispose();
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
      return { ok: false, error: { category: "provider_error", safeErrorCode: null, message: "Provider returned no stream body." } };
    }

    return {
      ok: true,
      events: this.streamEvents(res.body, scope, start),
      close: () => {
        scope.abort("cancelled");
        scope.dispose();
      },
      latencyMs,
    };
  }

  private async *streamEvents(
    body: ReadableStream<Uint8Array>,
    scope: AbortScope,
    start: number,
  ): AsyncGenerator<NormalizedStreamEvent> {
    const fail = (message: string): NormalizedStreamEvent => ({
      type: "error",
      error: { category: "provider_error", safeErrorCode: null, message },
    });
    let finishReason: NormalizedFinishReason | null = null;
    let usage: NormalizedProviderUsage = { inputTokens: null, outputTokens: null, totalTokens: null };
    let providerRequestId: string | null = null;
    let model: string | null = null;
    let sawDone = false;

    try {
      for await (const data of readSseData(body, scope, MAX_STREAM_BYTES)) {
        if (data === "[DONE]") {
          sawDone = true;
          break;
        }
        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          yield fail("Provider stream contained an invalid event.");
          return;
        }
        if (!isPlainObject(json)) {
          yield fail("Provider stream contained an invalid event.");
          return;
        }
        if (isPlainObject(json.error)) {
          yield fail("Provider reported an error mid-stream.");
          return;
        }
        if (typeof json.id === "string") providerRequestId = json.id;
        if (typeof json.model === "string") model = json.model;
        if (isPlainObject(json.usage)) usage = normalizeUsage(json.usage);

        const choice = Array.isArray(json.choices) && isPlainObject(json.choices[0]) ? json.choices[0] : null;
        if (!choice) continue;
        const delta = isPlainObject(choice.delta) ? choice.delta : null;
        if (delta) {
          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield { type: "text_delta", text: delta.content };
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const [position, raw] of delta.tool_calls.entries()) {
              if (!isPlainObject(raw)) {
                yield fail("Provider stream contained an invalid tool call.");
                return;
              }
              const fn = isPlainObject(raw.function) ? raw.function : {};
              yield {
                type: "tool_call_delta",
                index: typeof raw.index === "number" ? raw.index : position,
                ...(typeof raw.id === "string" ? { id: raw.id } : {}),
                ...(typeof fn.name === "string" ? { name: fn.name } : {}),
                ...(typeof fn.arguments === "string" && fn.arguments.length > 0 ? { argumentsDelta: fn.arguments } : {}),
              };
            }
          }
        }
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          finishReason = mapFinishReason(choice.finish_reason);
        }
      }
    } catch (error) {
      yield { type: "error", error: thrownError(error, scope, Date.now() - start) };
      return;
    } finally {
      scope.abort("cancelled");
      scope.dispose();
    }

    if (finishReason === null && !sawDone) {
      yield fail("Provider stream ended before completing.");
      return;
    }
    yield { type: "finish", finishReason, usage, providerRequestId, model };
  }
}
