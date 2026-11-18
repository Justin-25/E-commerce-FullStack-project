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
  | "INTERNAL_ERROR"
  // sign-in (milestone 3)
  | "CSRF_INVALID"
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_LOCKED"
  | "ACCOUNT_SUSPENDED"
  | "EMAIL_NOT_VERIFIED"
  | "INVALID_CODE";

export interface FieldError {
  path: string;
  message: string;
}

/** Extra facts a screen needs, e.g. { attemptsLeft: 2 } or { retryAfterSeconds: 840 }. */
export type ErrorDetails = Record<string, string | number | boolean>;

/**
 * An error that is safe to show to the user. Anything that is NOT an AppError
 * is treated as a bug: logged in full, answered with a generic 500.
 */
export class AppError extends Error {
  readonly fields?: FieldError[];
  readonly details?: ErrorDetails;

  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    extra: { fields?: FieldError[]; details?: ErrorDetails } = {}
  ) {
    super(message);
    this.name = "AppError";
    if (extra.fields) this.fields = extra.fields;
    if (extra.details) this.details = extra.details;
  }
}

/** The one error shape every endpoint returns (see openapi.yaml → Error). */
export function errorBody(code: ErrorCode, message: string, requestId: unknown, extra: { fields?: FieldError[]; details?: ErrorDetails } = {}) {
  return {
    error: {
      code,
      message,
      requestId: String(requestId ?? ""),
      ...(extra.fields ? { fields: extra.fields } : {}),
      ...(extra.details ? { details: extra.details } : {})
    }
  };
}
