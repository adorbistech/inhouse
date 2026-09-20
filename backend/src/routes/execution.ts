import { once } from "node:events";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config/index.js";
import type { CredentialVaultService } from "../lib/credentialVault.js";
import { authenticateApiKey } from "../services/apiKeyAuthService.js";
import { type AdapterRegistry, createDefaultAdapterRegistry } from "../services/adapters/adapterRegistry.js";
import { ExecutionService } from "../services/executionService.js";
import type { ExecutionContext, ExecutionOutcome, ExecutionRequest, ExecutionStreamOutcome } from "../services/execution/types.js";
import type { InhouseApiKeyRow } from "../repositories/types.js";
import {
  validateAnthropicMessagesInput,
  validateOpenAiChatCompletionInput,
  type ParsedExecutionInput,
} from "../validation/execution.js";
import {
  AnthropicStreamFormatter,
  OpenAiStreamFormatter,
  anthropicErrorBody,
  errorStatusCode,
  toAnthropicMessageResponse,
  toOpenAiChatCompletionResponse,
  type StreamFormatter,
} from "./executionFormatters.js";

/**
 * The public execution surface — every call here can result in a real
 * outbound provider request (see `services/executionService.ts`). Both
 * protocols share one normalized execution path; only request/response
 * *shape* translation lives here (`validation/execution.ts` inbound,
 * `executionFormatters.ts` outbound), never a provider- or vendor-specific
 * decision. Authentication is a client API key; which workloads that key
 * may use is enforced inside the execution service, before routing.
 */

type Protocol = "openai" | "anthropic";

function toExecutionRequest(parsed: ParsedExecutionInput): ExecutionRequest {
  return {
    workloadId: parsed.workloadId,
    modelAlias: parsed.modelAlias,
    messages: parsed.messages,
    maxOutputTokens: parsed.maxOutputTokens,
    temperature: parsed.temperature,
    tools: parsed.tools,
    toolChoice: parsed.toolChoice,
  };
}

/**
 * Aborts outbound provider work when the client goes away before the
 * response finished (a normally completed response has `writableFinished`
 * set, so it never triggers this).
 */
function abortOnClientClose(reply: FastifyReply): AbortController {
  const controller = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller;
}

function sendFailure(
  reply: FastifyReply,
  protocol: Protocol,
  outcome: Extract<ExecutionOutcome, { ok: false }> | Extract<ExecutionStreamOutcome, { ok: false }>,
): void {
  const status = errorStatusCode(outcome.category);
  if (protocol === "anthropic") {
    reply.code(status).send(anthropicErrorBody(status, outcome.message, outcome.requestId, outcome.executionId));
    return;
  }
  reply.code(status).send({
    error: {
      code: outcome.category.toUpperCase(),
      message: outcome.message,
      requestId: outcome.requestId,
      executionId: outcome.executionId,
    },
  });
}

/**
 * Streams normalized events to the client as Server-Sent Events without
 * buffering: each event is written as it arrives, and a slow client applies
 * backpressure (`drain`) to the provider read instead of growing memory.
 * The stream always ends with a terminal event; a client disconnect stops
 * iteration, which closes the provider connection and records the ledger.
 */
async function pipeSse(
  request: FastifyRequest,
  reply: FastifyReply,
  events: AsyncIterable<import("../services/providerAdapter.js").NormalizedStreamEvent>,
  formatter: StreamFormatter,
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "x-request-id": request.id,
  });

  const write = async (text: string): Promise<boolean> => {
    if (raw.destroyed || raw.writableEnded) return false;
    if (!raw.write(text)) {
      await Promise.race([once(raw, "drain"), once(raw, "close")]).catch(() => undefined);
    }
    return !raw.destroyed;
  };

  const iterator = events[Symbol.asyncIterator]();
  try {
    if (!(await write(formatter.start()))) return;
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) break;
      const chunk = formatter.format(value);
      if (chunk.text.length > 0 && !(await write(chunk.text))) break;
      if (chunk.terminal) break;
    }
  } finally {
    await iterator.return?.(undefined);
    if (!raw.writableEnded) raw.end();
  }
}

export function registerExecutionRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: AppConfig,
  credentialVault: CredentialVaultService,
  adapterRegistry: AdapterRegistry = createDefaultAdapterRegistry(),
): void {
  const service = new ExecutionService(pool, credentialVault, adapterRegistry);

  async function handle(
    protocol: Protocol,
    request: FastifyRequest,
    reply: FastifyReply,
    parse: (body: unknown, header: string | undefined) => ParsedExecutionInput,
  ): Promise<unknown> {
    const apiKey: InhouseApiKeyRow = await authenticateApiKey(pool, request.headers.authorization, request.headers["x-api-key"]);
    const headerWorkloadId = request.headers["x-inhouse-workload-id"];
    const parsed = parse(request.body, typeof headerWorkloadId === "string" ? headerWorkloadId : undefined);
    const ctx: ExecutionContext = {
      requestId: request.id,
      signal: abortOnClientClose(reply).signal,
      log: request.log,
    };
    const execRequest = toExecutionRequest(parsed);

    if (parsed.stream) {
      const outcome = await service.executeStream(apiKey, execRequest, ctx);
      if (!outcome.ok) {
        sendFailure(reply, protocol, outcome);
        return reply;
      }
      const formatter: StreamFormatter =
        protocol === "anthropic"
          ? new AnthropicStreamFormatter(outcome.executionId, parsed.modelAlias, request.id)
          : new OpenAiStreamFormatter(outcome.executionId, parsed.modelAlias, request.id);
      await pipeSse(request, reply, outcome.events, formatter);
      return reply;
    }

    const outcome = await service.execute(apiKey, execRequest, ctx);
    if (!outcome.ok) {
      sendFailure(reply, protocol, outcome);
      return reply;
    }
    reply.code(200);
    return protocol === "anthropic"
      ? toAnthropicMessageResponse(outcome, parsed.modelAlias)
      : toOpenAiChatCompletionResponse(outcome, parsed.modelAlias);
  }

  app.register(
    async (versioned) => {
      versioned.post("/chat/completions", (request, reply) =>
        handle("openai", request, reply, validateOpenAiChatCompletionInput),
      );

      // Anthropic clients parse errors as `{ type: "error", error: { type, message } }`, so this
      // route lives in its own encapsulated scope with a matching error handler.
      versioned.register(async (anthropic) => {
        anthropic.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
          const status =
            typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
          if (status >= 500) {
            request.log.error({ err: error }, "Unhandled error");
            reply.code(status).send(anthropicErrorBody(status, "An unexpected error occurred.", request.id));
            return;
          }
          request.log.warn({ err: error }, "Request error");
          reply.code(status).send(anthropicErrorBody(status, error.message, request.id));
        });
        anthropic.post("/messages", (request, reply) => handle("anthropic", request, reply, validateAnthropicMessagesInput));
      });
    },
    { prefix: config.apiPrefix },
  );
}
