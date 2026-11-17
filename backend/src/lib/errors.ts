export type ErrorCode =
  | "BAD_REQUEST"
  | "INVALID_JSON"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface FieldError {
  path: string;
  message: string;
}

/**
 * An error that is safe to show to the user. Anything that is NOT an AppError
 * is treated as a bug: logged in full, answered with a generic 500.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly fields?: FieldError[]
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** The one error shape every endpoint returns (see openapi.yaml → Error). */
export function errorBody(code: ErrorCode, message: string, requestId: unknown, fields?: FieldError[]) {
  return { error: { code, message, requestId: String(requestId ?? ""), ...(fields ? { fields } : {}) } };
}
