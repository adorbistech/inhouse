import type {
  NormalizedFinishReason,
  NormalizedProviderUsage,
  NormalizedStreamEvent,
  NormalizedToolCall,
} from "../services/providerAdapter.js";
import type { ExecutionErrorCategory, ExecutionSuccess } from "../services/execution/types.js";

/**
 * Public-protocol formatters: the *only* code that knows what an OpenAI- or
 * Anthropic-shaped response looks like. They consume the provider-neutral
 * execution result / stream events and never see a provider payload — and
 * they never invent data: a usage figure the provider did not report is
 * `null` in the ledger and only rendered as `0` where the wire format
 * requires a number (see docs/EXECUTION.md, "Usage on the wire").
 */

export function errorStatusCode(category: ExecutionErrorCategory): number {
  switch (category) {
    case "no_eligible_candidate":
    case "unavailable":
      return 503;
    case "rate_limit":
      return 429;
    case "timeout":
      return 504;
    case "invalid_request":
      return 400;
    case "cancelled":
      return 499;
    case "authentication":
    case "authorization":
    case "network":
    case "provider_error":
    case "configuration":
    case "model_not_found":
      return 502;
    default:
      return 500;
  }
}

function sse(data: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function safeParseObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text.length === 0 ? "{}" : text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const hexId = (executionId: string): string => executionId.replace(/-/g, "");

// ---------------------------------------------------------------- OpenAI

function openAiFinishReason(reason: NormalizedFinishReason | null): string {
  return reason === "other" || reason === null ? "stop" : reason;
}

function openAiUsage(usage: NormalizedProviderUsage) {
  return { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens };
}

function hasAnyUsage(usage: NormalizedProviderUsage): boolean {
  return usage.inputTokens !== null || usage.outputTokens !== null || usage.totalTokens !== null;
}

export function toOpenAiChatCompletionResponse(outcome: ExecutionSuccess, requestedModel: string) {
  return {
    id: `chatcmpl-${outcome.executionId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: outcome.output.length > 0 || outcome.toolCalls.length === 0 ? outcome.output : null,
          ...(outcome.toolCalls.length > 0
            ? {
                tool_calls: outcome.toolCalls.map((tc: NormalizedToolCall) => ({
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: tc.arguments },
                })),
              }
            : {}),
        },
        finish_reason: openAiFinishReason(outcome.finishReason),
      },
    ],
    usage: openAiUsage(outcome.usage),
  };
}

export interface StreamChunk {
  text: string;
  /** True when this chunk ends the stream (normal finish or error). */
  terminal: boolean;
}

export interface StreamFormatter {
  /** Emitted once, right after the response headers. */
  start(): string;
  format(event: NormalizedStreamEvent): StreamChunk;
}

export class OpenAiStreamFormatter implements StreamFormatter {
  private readonly id: string;
  private readonly created = Math.floor(Date.now() / 1000);

  constructor(
    executionId: string,
    private readonly requestedModel: string,
    private readonly requestId: string,
  ) {
    this.id = `chatcmpl-${executionId}`;
  }

  private chunk(delta: Record<string, unknown>, finishReason: string | null = null, extra: Record<string, unknown> = {}): string {
    return sse({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.requestedModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extra,
    });
  }

  start(): string {
    return this.chunk({ role: "assistant", content: "" });
  }

  format(event: NormalizedStreamEvent): StreamChunk {
    switch (event.type) {
      case "text_delta":
        return { text: this.chunk({ content: event.text }), terminal: false };
      case "tool_call_delta":
        return {
          text: this.chunk({
            tool_calls: [
              {
                index: event.index,
                ...(event.id !== undefined ? { id: event.id, type: "function" } : {}),
                function: {
                  ...(event.name !== undefined ? { name: event.name } : {}),
                  ...(event.argumentsDelta !== undefined ? { arguments: event.argumentsDelta } : {}),
                },
              },
            ],
          }),
          terminal: false,
        };
      case "finish": {
        let text = this.chunk({}, openAiFinishReason(event.finishReason));
        if (hasAnyUsage(event.usage)) {
          text += sse({
            id: this.id,
            object: "chat.completion.chunk",
            created: this.created,
            model: this.requestedModel,
            choices: [],
            usage: openAiUsage(event.usage),
          });
        }
        return { text: `${text}data: [DONE]\n\n`, terminal: true };
      }
      case "error":
        return {
          text:
            sse({ error: { code: event.error.category.toUpperCase(), message: event.error.message, requestId: this.requestId } }) +
            "data: [DONE]\n\n",
          terminal: true,
        };
    }
  }
}

// ------------------------------------------------------------- Anthropic

function anthropicStopReason(reason: NormalizedFinishReason | null): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

export function anthropicErrorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 503) return "overloaded_error";
  return "api_error";
}

export function anthropicErrorBody(status: number, message: string, requestId: string, executionId?: string) {
  return {
    type: "error",
    error: { type: anthropicErrorType(status), message },
    request_id: requestId,
    ...(executionId ? { execution_id: executionId } : {}),
  };
}

export function toAnthropicMessageResponse(outcome: ExecutionSuccess, requestedModel: string) {
  const content: Array<Record<string, unknown>> = [];
  if (outcome.output.length > 0 || outcome.toolCalls.length === 0) {
    content.push({ type: "text", text: outcome.output });
  }
  for (const tc of outcome.toolCalls) {
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input: safeParseObject(tc.arguments) });
  }
  return {
    id: `msg_${hexId(outcome.executionId)}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: anthropicStopReason(outcome.finishReason),
    stop_sequence: null,
    usage: { input_tokens: outcome.usage.inputTokens ?? 0, output_tokens: outcome.usage.outputTokens ?? 0 },
  };
}

/** Stateful: Anthropic streams are a sequence of explicitly opened/closed content blocks. */
export class AnthropicStreamFormatter implements StreamFormatter {
  private readonly id: string;
  private nextBlock = 0;
  private open: { kind: "text" } | { kind: "tool"; providerIndex: number } | null = null;

  constructor(
    executionId: string,
    private readonly requestedModel: string,
    private readonly requestId: string,
  ) {
    this.id = `msg_${hexId(executionId)}`;
  }

  start(): string {
    return sse(
      {
        type: "message_start",
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: this.requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      "message_start",
    );
  }

  private closeOpenBlock(): string {
    if (!this.open) return "";
    const out = sse({ type: "content_block_stop", index: this.nextBlock - 1 }, "content_block_stop");
    this.open = null;
    return out;
  }

  format(event: NormalizedStreamEvent): StreamChunk {
    switch (event.type) {
      case "text_delta": {
        let text = "";
        if (this.open?.kind !== "text") {
          text += this.closeOpenBlock();
          text += sse(
            { type: "content_block_start", index: this.nextBlock, content_block: { type: "text", text: "" } },
            "content_block_start",
          );
          this.nextBlock++;
          this.open = { kind: "text" };
        }
        text += sse(
          { type: "content_block_delta", index: this.nextBlock - 1, delta: { type: "text_delta", text: event.text } },
          "content_block_delta",
        );
        return { text, terminal: false };
      }
      case "tool_call_delta": {
        let text = "";
        if (this.open?.kind !== "tool" || this.open.providerIndex !== event.index) {
          if (event.id === undefined || event.name === undefined) {
            // A tool call may only begin with its id and name — anything else is a malformed provider stream.
            return this.fail("Provider stream contained an invalid tool call.");
          }
          text += this.closeOpenBlock();
          text += sse(
            {
              type: "content_block_start",
              index: this.nextBlock,
              content_block: { type: "tool_use", id: event.id, name: event.name, input: {} },
            },
            "content_block_start",
          );
          this.nextBlock++;
          this.open = { kind: "tool", providerIndex: event.index };
        }
        if (event.argumentsDelta !== undefined) {
          text += sse(
            {
              type: "content_block_delta",
              index: this.nextBlock - 1,
              delta: { type: "input_json_delta", partial_json: event.argumentsDelta },
            },
            "content_block_delta",
          );
        }
        return { text, terminal: false };
      }
      case "finish": {
        let text = this.closeOpenBlock();
        text += sse(
          {
            type: "message_delta",
            delta: { stop_reason: anthropicStopReason(event.finishReason), stop_sequence: null },
            usage: {
              ...(event.usage.inputTokens !== null ? { input_tokens: event.usage.inputTokens } : {}),
              output_tokens: event.usage.outputTokens ?? 0,
            },
          },
          "message_delta",
        );
        text += sse({ type: "message_stop" }, "message_stop");
        return { text, terminal: true };
      }
      case "error":
        return {
          text: sse(anthropicErrorBody(errorStatusCode(event.error.category), event.error.message, this.requestId), "error"),
          terminal: true,
        };
    }
  }

  private fail(message: string): StreamChunk {
    return {
      text: sse(anthropicErrorBody(502, message, this.requestId), "error"),
      terminal: true,
    };
  }
}
