import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

function buildErrorBody(code: string, message: string, requestId: string): ApiErrorBody {
  return { error: { code, message, requestId } };
}

/**
 * Registers a single, consistent error shape for the whole API:
 * { error: { code, message, requestId } }. Never leaks stack traces.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply
      .code(404)
      .send(buildErrorBody("NOT_FOUND", `Route ${request.method} ${request.url} not found`, request.id));
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, "Unhandled error");
      reply
        .code(statusCode)
        .send(buildErrorBody("INTERNAL_SERVER_ERROR", "An unexpected error occurred.", request.id));
      return;
    }

    request.log.warn({ err: error }, "Request error");
    const code = error.code ?? "BAD_REQUEST";
    reply.code(statusCode).send(buildErrorBody(code, error.message, request.id));
  });
}
