import { ValidationError } from "../lib/httpErrors.js";
import type {
  NormalizedToolCall,
  NormalizedToolChoice,
  NormalizedToolDefinition,
} from "../services/providerAdapter.js";
import type { ExecutionMessage } from "../services/execution/types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_LENGTH = 200_000;
const MAX_TOOLS = 128;
const MAX_TOOL_CALLS_PER_MESSAGE = 64;
const MAX_TOOL_ARGUMENTS_LENGTH = 200_000;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves which `workloads` row an execution request targets. Neither
 * the OpenAI nor the Anthropic wire format has a "workload" concept, so
 * this is Inhouse's one deliberate extension to both — accepted as a
 * request-body field (for a caller that can add one) or, for a client
 * that can only send an unmodified stock request body (e.g. pointing an
 * existing OpenAI/Claude-compatible tool's `base_url` at Inhouse), as the
 * `x-inhouse-workload-id` header instead. The body field wins if both are
 * present. See docs/EXECUTION.md, "Workload Resolution".
 */
export function resolveWorkloadId(body: Record<string, unknown>, headerWorkloadId: string | undefined): string {
  const fromBody = body.workloadId;
  const raw = typeof fromBody === "string" && fromBody.length > 0 ? fromBody : headerWorkloadId;
  if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) {
    throw new ValidationError(
      'A target workload is required: pass "workloadId" in the request body or the "x-inhouse-workload-id" header, as a valid UUID.',
    );
  }
  return raw;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`"${field}" must be a non-empty string.`);
  }
  if (value.length > MAX_MESSAGE_LENGTH) {
    throw new ValidationError(`"${field}" exceeds the maximum allowed length.`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`"${field}" must be a number.`);
  }
  return value;
}

export interface ParsedExecutionInput {
  workloadId: string;
  modelAlias: string;
  messages: ExecutionMessage[];
  maxOutputTokens: number | null;
  temperature: number | null;
  stream: boolean;
  tools: NormalizedToolDefinition[];
  toolChoice: NormalizedToolChoice | null;
}

function requireToolName(value: unknown, field: string): string {
  if (typeof value !== "string" || !TOOL_NAME_PATTERN.test(value)) {
    throw new ValidationError(`"${field}" must be 1-64 characters of letters, digits, "_" or "-".`);
  }
  return value;
}

function requireToolId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new ValidationError(`"${field}" must be a non-empty string of at most 200 characters.`);
  }
  return value;
}

/** Tool arguments are transported, never executed — but a client-supplied history entry must still be parseable JSON. */
function requireJsonObjectText(text: string, field: string): string {
  if (text.length > MAX_TOOL_ARGUMENTS_LENGTH) {
    throw new ValidationError(`"${field}" exceeds the maximum allowed length.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.length === 0 ? "{}" : text);
  } catch {
    throw new ValidationError(`"${field}" must be valid JSON.`);
  }
  if (!isPlainObject(parsed)) {
    throw new ValidationError(`"${field}" must be a JSON object.`);
  }
  return text.length === 0 ? "{}" : text;
}

function optionalSchema(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return { type: "object", properties: {} };
  if (!isPlainObject(value)) {
    throw new ValidationError(`"${field}" must be a JSON Schema object.`);
  }
  return value;
}

/**
 * Every tool result must answer a tool call an earlier assistant turn
 * actually made, exactly once — a dangling or duplicated `tool` message is
 * a malformed conversation no provider would accept, so it is rejected here
 * (a 400 for the caller) rather than forwarded.
 */
function assertToolResultsLinked(messages: ExecutionMessage[]): void {
  const open = new Set<string>();
  for (const [i, m] of messages.entries()) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) open.add(tc.id);
    } else if (m.role === "tool") {
      if (!open.delete(m.toolCallId)) {
        throw new ValidationError(`"messages[${i}]" is a tool result that does not answer an earlier tool call.`);
      }
    }
  }
}

/** Text-only content: a string, or (for parts-style protocols) an array of text parts. Anything else is refused, never dropped. */
function extractText(content: unknown, field: string, allowEmpty = false): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const [i, part] of content.entries()) {
      if (!isPlainObject(part) || part.type !== "text" || typeof part.text !== "string") {
        throw new ValidationError(`"${field}[${i}]" must be a text content part — only text content is supported.`);
      }
      parts.push(part.text);
    }
    text = parts.join("\n");
  } else {
    throw new ValidationError(`"${field}" must be a string or an array of text content parts.`);
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new ValidationError(`"${field}" exceeds the maximum allowed length.`);
  }
  if (!allowEmpty && text.length === 0) {
    throw new ValidationError(`"${field}" must be non-empty.`);
  }
  return text;
}

/**
 * OpenAI `/v1/chat/completions`-shaped body. Accepts the subset of the real
 * contract Inhouse implements: text messages, `tools`/`tool_choice`,
 * assistant `tool_calls` and `tool` result messages, streaming. Legacy
 * `functions`/`function_call` and non-text content parts are rejected, not
 * swallowed. Sampling fields Inhouse does not forward (`top_p`, `stop`, …)
 * are accepted and ignored — see docs/EXECUTION.md.
 */
export function validateOpenAiChatCompletionInput(
  body: unknown,
  headerWorkloadId: string | undefined,
): ParsedExecutionInput {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  if (body.functions !== undefined || body.function_call !== undefined) {
    throw new ValidationError('Legacy "functions"/"function_call" are not supported; use "tools".');
  }

  const workloadId = resolveWorkloadId(body, headerWorkloadId);
  const modelAlias = requireNonEmptyString(body.model, "model");

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ValidationError('"messages" must be a non-empty array.');
  }
  if (body.messages.length > MAX_MESSAGES) {
    throw new ValidationError(`"messages" must contain at most ${MAX_MESSAGES} entries.`);
  }
  const messages: ExecutionMessage[] = body.messages.map((raw, index): ExecutionMessage => {
    if (!isPlainObject(raw)) {
      throw new ValidationError(`"messages[${index}]" must be an object.`);
    }
    const role = raw.role;
    const field = `messages[${index}]`;
    if (role === "system" || role === "user") {
      return { role, content: extractText(raw.content, `${field}.content`) };
    }
    if (role === "tool") {
      return {
        role: "tool",
        toolCallId: requireToolId(raw.tool_call_id, `${field}.tool_call_id`),
        content: extractText(raw.content, `${field}.content`, true),
      };
    }
    if (role === "assistant") {
      const toolCalls = parseOpenAiToolCalls(raw.tool_calls, `${field}.tool_calls`);
      const content =
        raw.content === null || raw.content === undefined
          ? ""
          : extractText(raw.content, `${field}.content`, toolCalls.length > 0);
      if (content.length === 0 && toolCalls.length === 0) {
        throw new ValidationError(`"${field}" must have content or tool_calls.`);
      }
      return { role: "assistant", content, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
    }
    throw new ValidationError(`"${field}.role" must be one of: system, user, assistant, tool.`);
  });
  assertToolResultsLinked(messages);

  const tools = parseOpenAiTools(body.tools);
  return {
    workloadId,
    modelAlias,
    messages,
    maxOutputTokens: body.max_tokens !== undefined ? optionalNumber(body.max_tokens, "max_tokens") : null,
    temperature: body.temperature !== undefined ? optionalNumber(body.temperature, "temperature") : null,
    stream: body.stream === true,
    tools,
    toolChoice: tools.length > 0 ? parseOpenAiToolChoice(body.tool_choice) : null,
  };
}

function parseOpenAiToolCalls(raw: unknown, field: string): NormalizedToolCall[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ValidationError(`"${field}" must be an array.`);
  if (raw.length > MAX_TOOL_CALLS_PER_MESSAGE) {
    throw new ValidationError(`"${field}" must contain at most ${MAX_TOOL_CALLS_PER_MESSAGE} entries.`);
  }
  return raw.map((entry, i) => {
    const f = `${field}[${i}]`;
    if (!isPlainObject(entry) || entry.type !== "function" || !isPlainObject(entry.function)) {
      throw new ValidationError(`"${f}" must be a function tool call.`);
    }
    const args = entry.function.arguments;
    if (typeof args !== "string") {
      throw new ValidationError(`"${f}.function.arguments" must be a JSON string.`);
    }
    return {
      id: requireToolId(entry.id, `${f}.id`),
      name: requireToolName(entry.function.name, `${f}.function.name`),
      arguments: requireJsonObjectText(args, `${f}.function.arguments`),
    };
  });
}

function parseOpenAiTools(raw: unknown): NormalizedToolDefinition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ValidationError('"tools" must be an array.');
  if (raw.length > MAX_TOOLS) throw new ValidationError(`"tools" must contain at most ${MAX_TOOLS} entries.`);
  return raw.map((entry, i) => {
    if (!isPlainObject(entry) || entry.type !== "function" || !isPlainObject(entry.function)) {
      throw new ValidationError(`"tools[${i}]" must be a function tool definition.`);
    }
    const fn = entry.function;
    return {
      name: requireToolName(fn.name, `tools[${i}].function.name`),
      description: typeof fn.description === "string" ? fn.description : null,
      inputSchema: optionalSchema(fn.parameters, `tools[${i}].function.parameters`),
    };
  });
}

function parseOpenAiToolChoice(raw: unknown): NormalizedToolChoice | null {
  if (raw === undefined || raw === null) return null;
  if (raw === "auto" || raw === "none" || raw === "required") return raw;
  if (isPlainObject(raw) && raw.type === "function" && isPlainObject(raw.function)) {
    return { name: requireToolName(raw.function.name, "tool_choice.function.name") };
  }
  throw new ValidationError('"tool_choice" must be "auto", "none", "required" or a function selector.');
}

/** Anthropic system/content text: a string or an array of text blocks (`cache_control` and similar annotations are ignored). */
function extractAnthropicText(content: unknown, field: string, allowEmpty = false): string {
  if (typeof content === "string") {
    if (!allowEmpty && content.length === 0) throw new ValidationError(`"${field}" must be non-empty.`);
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const [i, block] of content.entries()) {
      if (!isPlainObject(block) || block.type !== "text" || typeof block.text !== "string") {
        throw new ValidationError(`"${field}[${i}]" must be a text block — only text content is supported.`);
      }
      parts.push(block.text);
    }
    const text = parts.join("\n");
    if (!allowEmpty && text.length === 0) throw new ValidationError(`"${field}" must be non-empty.`);
    if (text.length > MAX_MESSAGE_LENGTH) throw new ValidationError(`"${field}" exceeds the maximum allowed length.`);
    return text;
  }
  throw new ValidationError(`"${field}" must be a string or an array of text blocks.`);
}

function parseAnthropicTools(raw: unknown): NormalizedToolDefinition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ValidationError('"tools" must be an array.');
  if (raw.length > MAX_TOOLS) throw new ValidationError(`"tools" must contain at most ${MAX_TOOLS} entries.`);
  return raw.map((entry, i) => {
    if (!isPlainObject(entry)) throw new ValidationError(`"tools[${i}]" must be an object.`);
    if (entry.type !== undefined && entry.type !== "custom") {
      throw new ValidationError(`"tools[${i}]" uses an unsupported tool type; only client-defined (custom) tools are supported.`);
    }
    return {
      name: requireToolName(entry.name, `tools[${i}].name`),
      description: typeof entry.description === "string" ? entry.description : null,
      inputSchema: optionalSchema(entry.input_schema, `tools[${i}].input_schema`),
    };
  });
}

function parseAnthropicToolChoice(raw: unknown): NormalizedToolChoice | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) throw new ValidationError('"tool_choice" must be an object.');
  switch (raw.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { name: requireToolName(raw.name, "tool_choice.name") };
    default:
      throw new ValidationError('"tool_choice.type" must be one of: auto, any, none, tool.');
  }
}

/**
 * Anthropic `/v1/messages`-shaped body. `system` is a distinct top-level
 * field (never a `"system"`-role message) — translated into the same
 * normalized `system` message the execution layer already expects. Content
 * blocks map onto the provider-neutral model: `text` -> text,
 * assistant `tool_use` -> `toolCalls`, user `tool_result` -> `tool`
 * messages (emitted before that turn's remaining text, the order every
 * tool-calling protocol requires). Images, documents, thinking blocks and
 * server-side tools are refused rather than silently dropped.
 */
export function validateAnthropicMessagesInput(
  body: unknown,
  headerWorkloadId: string | undefined,
): ParsedExecutionInput {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }

  const workloadId = resolveWorkloadId(body, headerWorkloadId);
  const modelAlias = requireNonEmptyString(body.model, "model");

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ValidationError('"messages" must be a non-empty array.');
  }
  if (body.messages.length > MAX_MESSAGES) {
    throw new ValidationError(`"messages" must contain at most ${MAX_MESSAGES} entries.`);
  }

  const messages: ExecutionMessage[] = [];
  if (body.system !== undefined && body.system !== null) {
    const system = extractAnthropicText(body.system, "system", true);
    if (system.length > 0) messages.push({ role: "system", content: system });
  }
  body.messages.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      throw new ValidationError(`"messages[${index}]" must be an object.`);
    }
    const role = raw.role;
    const field = `messages[${index}].content`;
    if (role !== "user" && role !== "assistant") {
      throw new ValidationError(`"messages[${index}].role" must be one of: user, assistant.`);
    }
    if (typeof raw.content === "string") {
      messages.push({ role, content: requireNonEmptyString(raw.content, field) });
      return;
    }
    if (!Array.isArray(raw.content) || raw.content.length === 0) {
      throw new ValidationError(`"${field}" must be a non-empty string or array of content blocks.`);
    }

    const texts: string[] = [];
    const toolCalls: NormalizedToolCall[] = [];
    const toolResults: ExecutionMessage[] = [];
    for (const [b, block] of raw.content.entries()) {
      const bf = `${field}[${b}]`;
      if (!isPlainObject(block)) throw new ValidationError(`"${bf}" must be an object.`);
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (block.type === "tool_use" && role === "assistant") {
        if (!isPlainObject(block.input)) throw new ValidationError(`"${bf}.input" must be a JSON object.`);
        toolCalls.push({
          id: requireToolId(block.id, `${bf}.id`),
          name: requireToolName(block.name, `${bf}.name`),
          arguments: requireJsonObjectText(JSON.stringify(block.input), `${bf}.input`),
        });
      } else if (block.type === "tool_result" && role === "user") {
        toolResults.push({
          role: "tool",
          toolCallId: requireToolId(block.tool_use_id, `${bf}.tool_use_id`),
          content: block.content === undefined || block.content === null ? "" : extractAnthropicText(block.content, `${bf}.content`, true),
        });
      } else {
        throw new ValidationError(`"${bf}" has an unsupported content block type; only text, tool_use and tool_result are supported.`);
      }
    }
    if (toolCalls.length > MAX_TOOL_CALLS_PER_MESSAGE) {
      throw new ValidationError(`"${field}" contains too many tool_use blocks.`);
    }
    const text = texts.join("\n");
    if (text.length > MAX_MESSAGE_LENGTH) throw new ValidationError(`"${field}" exceeds the maximum allowed length.`);
    messages.push(...toolResults);
    if (role === "assistant") {
      if (text.length === 0 && toolCalls.length === 0) throw new ValidationError(`"${field}" must have text or tool_use blocks.`);
      messages.push({ role: "assistant", content: text, ...(toolCalls.length > 0 ? { toolCalls } : {}) });
    } else if (text.length > 0) {
      messages.push({ role: "user", content: text });
    } else if (toolResults.length === 0) {
      throw new ValidationError(`"${field}" must not be empty.`);
    }
  });
  assertToolResultsLinked(messages);

  const maxOutputTokens = optionalNumber(body.max_tokens, "max_tokens");
  if (maxOutputTokens === null) {
    // Unlike OpenAI, Anthropic requires max_tokens on every request.
    throw new ValidationError('"max_tokens" is required.');
  }

  const tools = parseAnthropicTools(body.tools);
  return {
    workloadId,
    modelAlias,
    messages,
    maxOutputTokens,
    temperature: body.temperature !== undefined ? optionalNumber(body.temperature, "temperature") : null,
    stream: body.stream === true,
    tools,
    toolChoice: tools.length > 0 ? parseAnthropicToolChoice(body.tool_choice) : null,
  };
}
