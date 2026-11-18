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

export type RegisterInput = z.infer<typeof registerSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
