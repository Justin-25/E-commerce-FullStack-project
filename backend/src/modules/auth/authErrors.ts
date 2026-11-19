import { AppError } from "../../lib/errors.js";

/** The safe, user-facing errors of the sign-in module, in one place. */

export const BREACHED_MESSAGE = "This password has appeared in a data breach. Choose one you don't use anywhere else.";

export const notSignedIn = () => new AppError(401, "UNAUTHORIZED", "Please sign in to continue.");
export const suspended = () => new AppError(403, "ACCOUNT_SUSPENDED", "This account is suspended. Contact Vendora support for help.");
export const invalidCode = () => new AppError(400, "INVALID_CODE", "That code isn't right or has expired. Check the latest email or request a new code.");
export const invalidLink = () => new AppError(400, "INVALID_LINK", "This reset link has expired or was already used. Request a new one.");
export const refreshConflict = () => new AppError(409, "CONFLICT", "You were just signed in again in another tab. Please retry.");
export const challengeExpired = () => new AppError(400, "CHALLENGE_EXPIRED", "Your sign-in timed out. Please sign in again.");
export const reauthRequired = () => new AppError(403, "REAUTH_REQUIRED", "Please confirm it's you to continue.");

export const fieldError = (path: string, message: string, details?: Record<string, number>) =>
  new AppError(400, "VALIDATION_ERROR", "Some fields are invalid", { fields: [{ path, message }], ...(details ? { details } : {}) });

export const locked = (retryAfterSeconds: number) =>
  new AppError(429, "ACCOUNT_LOCKED", "Too many sign-in attempts. Sign-in is paused for 15 minutes.", { details: { retryAfterSeconds } });

export const wrongSecondFactor = (attemptsLeft: number, usedBackupCode: boolean) =>
  new AppError(
    400,
    "INVALID_CODE",
    usedBackupCode ? "That backup code isn't right or was already used." : "That code isn't right. Check your authenticator app and try again.",
    { details: { attemptsLeft } }
  );
