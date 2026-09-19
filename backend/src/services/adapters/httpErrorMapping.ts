import type { ProviderErrorCategory, ProviderExecutionErrorCategory } from "../providerAdapter.js";

/**
 * Shared, protocol-agnostic helpers every HTTP-transport adapter uses so
 * error/timeout/network handling is identical across protocols — a new
 * protocol adapter reuses these rather than reinventing status-code
 * mapping. Nothing here is specific to any one business provider.
 */

/** Bounds how large a request body an adapter will ever construct and send. */
export const MAX_REQUEST_BODY_BYTES = 2_000_000;

/**
 * Bounds how large a provider *response* body an adapter will ever read
 * into memory before parsing it. A `Content-Length` header is not
 * trusted alone (it can be absent under chunked transfer, or simply
 * wrong) — `readBoundedResponseText` enforces this by streaming and
 * counting actual bytes received, aborting the read the moment the cap
 * is crossed, so a misbehaving or malicious provider response can never
 * be fully buffered regardless of what it claims about its own size.
 */
export const MAX_RESPONSE_BODY_BYTES = 2_000_000;

/**
 * Reads `res`'s body as UTF-8 text, refusing to buffer more than
 * `maxBytes`. Returns `null` (never throws) when the body exceeds the
 * bound — the caller treats that exactly like any other malformed/
 * oversized provider response, never as a crash.
 */
export async function readBoundedResponseText(res: Response, maxBytes: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No stream available (e.g. an empty body, or a Response implementation
    // without streaming support) — fall back to the buffered API, still
    // bounded by checking the result afterward.
    const text = await res.text();
    return Buffer.byteLength(text, "utf8") > maxBytes ? null : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/**
 * Maps an HTTP status from a *health* check (a minimal, read-only call) to
 * the narrower `ProviderErrorCategory` health observations are constrained
 * to (see `validation/providerHealth.ts`'s `ERROR_CATEGORIES`). Never
 * "invalid_request"/"model_not_found"/"unavailable" — those only make
 * sense for a generation request, not a lightweight health probe.
 */
export function categorizeHealthHttpStatus(status: number): ProviderErrorCategory {
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "provider_error";
  if (status >= 400) return "configuration";
  return "unknown";
}

/**
 * Maps an HTTP status from a *generation* request to the broader
 * `ProviderExecutionErrorCategory`. Deliberately conservative about 404:
 * an OpenAI-compatible chat-completions 404 body almost always means "this
 * model id doesn't exist for this account," not "this endpoint is wrong"
 * (a wrong endpoint fails at the network layer, not with a provider-shaped
 * 404 response).
 */
export function categorizeExecutionHttpStatus(status: number): ProviderExecutionErrorCategory {
  if (status === 400) return "invalid_request";
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 404) return "model_not_found";
  if (status === 429) return "rate_limit";
  if (status === 503) return "unavailable";
  if (status >= 500) return "provider_error";
  if (status >= 400) return "invalid_request";
  return "unknown";
}

/** `fetch`'s `AbortController`-triggered rejection — always a `DOMException` named `"AbortError"`. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * A short, safe, technical code for a network-layer failure — never the
 * full error message, which for some Node error types can embed the
 * request URL or other request-shaped detail.
 */
export function safeNetworkErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return null;
}

export function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
