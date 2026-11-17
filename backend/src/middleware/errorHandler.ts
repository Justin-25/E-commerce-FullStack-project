import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError, errorBody, type ErrorCode, type FieldError } from "../lib/errors.js";

interface BodyParserError {
  type?: string;
  status?: number;
}
const isBodyParserError = (err: unknown): err is BodyParserError =>
  typeof err === "object" && err !== null && "type" in err && typeof (err as BodyParserError).type === "string";

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json(errorBody("NOT_FOUND", "Route not found", req.id));
};

/**
 * Turns every error into the standard JSON error. Users only ever see safe
 * messages; stack traces and internal details stay in the server log, tied to
 * the same requestId so support can find them.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  let status = 500;
  let code: ErrorCode = "INTERNAL_ERROR";
  let message = "Something went wrong. Please try again.";
  let fields: FieldError[] | undefined;

  if (err instanceof AppError) {
    ({ status, code, message, fields } = err);
  } else if (err instanceof ZodError) {
    status = 400;
    code = "VALIDATION_ERROR";
    message = "Some fields are invalid";
    fields = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  } else if (isBodyParserError(err)) {
    if (err.type === "entity.parse.failed") {
      status = 400; code = "INVALID_JSON"; message = "Request body is not valid JSON";
    } else if (err.type === "entity.too.large") {
      status = 413; code = "PAYLOAD_TOO_LARGE"; message = "Request body is too large";
    } else if (err.status && err.status >= 400 && err.status < 500) {
      status = err.status; code = "BAD_REQUEST"; message = "Bad request";
    }
  }

  if (status >= 500) req.log.error({ err }, "unhandled error");
  res.status(status).json(errorBody(code, message, req.id, fields));
};
