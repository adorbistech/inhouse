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

export class UnauthorizedError extends HttpError {
  constructor(message = "Missing, invalid, or disabled Inhouse API key.") {
    super(401, "UNAUTHENTICATED", message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "This API key is not permitted to perform this action.", code = "FORBIDDEN") {
    super(403, code, message);
    this.name = "ForbiddenError";
  }
}

/** Raised when a required server-side configuration (never a caller mistake) is absent, so the route fails closed. */
export class ServiceUnavailableError extends HttpError {
  constructor(code: string, message: string) {
    super(503, code, message);
    this.name = "ServiceUnavailableError";
  }
}
