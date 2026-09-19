/**
 * Errors thrown here carry `statusCode`/`code` so Fastify's existing error
 * handler (src/plugins/errorHandler.ts) formats them into the standard
 * `{ error: { code, message, requestId } }` shape without any route-level
 * try/catch — Fastify routes async handler rejections to that handler.
 */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class ValidationError extends HttpError {
  constructor(message: string) {
    super(400, "VALIDATION_ERROR", message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, "NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, "CONFLICT", message);
    this.name = "ConflictError";
  }
}
