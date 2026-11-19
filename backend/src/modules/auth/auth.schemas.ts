import { z } from "zod";

// Allow-lists: only these fields are read; anything else in the body is dropped.

const email = z
  .string({ error: "Enter your email address" })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "Enter a valid email address" }).max(254, { error: "Email address is too long" }));

// 128 is generous for passphrases and caps the hashing work an attacker can cause per request.
const newPassword = z
  .string({ error: "Enter a password" })
  .min(8, { error: "Use at least 8 characters" })
  .max(128, { error: "Use 128 characters or fewer" });

const keepSignedIn = z.boolean().optional().default(false);

export const registerSchema = z.object({
  name: z.string({ error: "Enter your name" }).trim().min(1, { error: "Enter your name" }).max(100, { error: "Use 100 characters or fewer" }),
  email,
  password: newPassword
});

export const verifyEmailSchema = z.object({
  email,
  code: z.string({ error: "Enter the 6-digit code" }).regex(/^\d{6}$/, { error: "Enter the 6-digit code" }),
  keepSignedIn
});

export const resendSchema = z.object({ email });

export const loginSchema = z.object({
  email,
  // No length rules at sign-in (old passwords must keep working), but a cap against huge inputs.
  password: z.string({ error: "Enter your password" }).min(1, { error: "Enter your password" }).max(128, { error: "Email or password is incorrect." }),
  keepSignedIn
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  // 32 random bytes in base64url = 43 characters; anything else can't be one of our links.
  token: z.string({ error: "This reset link is incomplete" }).regex(/^[A-Za-z0-9_-]{43}$/, { error: "This reset link is incomplete" }),
  password: newPassword,
  keepSignedIn
});

export const changePasswordSchema = z.object({
  currentPassword: z.string({ error: "Enter your current password" }).min(1, { error: "Enter your current password" }).max(128, { error: "That's not your current password." }),
  newPassword
});

// --- two-step verification (3c) ---

const appCode = z.string({ error: "Enter the 6-digit code from the app" }).trim().regex(/^\d{6}$/, { error: "Enter the 6-digit code from the app" });
const backupCode = z.string().trim().min(10, { error: "Enter a backup code like kq7mz-4hx2p" }).max(20, { error: "Enter a backup code like kq7mz-4hx2p" });

/** Either the app code or a backup code ("Use a backup code instead"), not both. */
const secondFactor = z
  .object({ code: appCode.optional(), backupCode: backupCode.optional() })
  .refine((v) => (v.code === undefined) !== (v.backupCode === undefined), { error: "Enter the 6-digit code from the app", path: ["code"] });

export const twoFactorVerifySchema = secondFactor.and(z.object({ trustDevice: z.boolean().optional().default(false) }));
export const twoFactorDisableSchema = secondFactor;
export const appCodeSchema = z.object({ code: appCode });

export type SecondFactorInput = z.infer<typeof secondFactor>;

// --- account security (3d) ---

/** "Confirm it's you": the app code, the password, or the emailed code, depending on the account. */
export const confirmSchema = z
  .object({
    code: z.string().trim().regex(/^\d{6}$/, { error: "Enter the 6-digit code" }).optional(),
    password: z.string().min(1, { error: "Enter your password" }).max(128, { error: "That's not your password." }).optional()
  })
  .refine((v) => (v.code === undefined) !== (v.password === undefined), { error: "Enter your password or the 6-digit code", path: ["code"] });

export const changeEmailSchema = z.object({ newEmail: email });
export const emailCodeSchema = z.object({ code: z.string({ error: "Enter the 6-digit code" }).trim().regex(/^\d{6}$/, { error: "Enter the 6-digit code" }) });
export const sessionIdSchema = z.object({ id: z.uuid({ error: "Unknown device" }) });
export const activityQuerySchema = z.object({
  before: z.uuid({ error: "Invalid cursor" }).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

export type ConfirmInput = z.infer<typeof confirmSchema>;

// --- Google sign-in (3e) ---

export const googleLinkSchema = z.object({
  password: z.string({ error: "Enter your password" }).min(1, { error: "Enter your password" }).max(128, { error: "Email or password is incorrect." })
});
export const googleStartQuerySchema = z.object({
  mode: z.enum(["sign_in", "connect"]).default("sign_in"),
  keepSignedIn: z.enum(["true", "false"]).default("false").transform((v) => v === "true")
});
export type TwoFactorVerifyInput = z.infer<typeof twoFactorVerifySchema>;

export type RegisterInput = z.infer<typeof registerSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
