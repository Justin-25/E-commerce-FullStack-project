import type { EmailMessage } from "../../lib/email.js";

// Plain-text emails. The verification email deliberately doesn't include the name typed into the
// sign-up form: anyone can type any email there, so a name like "Click evil.example" would turn
// our email into a phishing message for a stranger.

export const verifyEmailMessage = (to: string, code: string, minutes: number): EmailMessage => ({
  to,
  kind: "verify-email",
  subject: "Your Vendora verification code",
  text: [
    "Hi,",
    "",
    `Your Vendora verification code is ${code}. It expires in ${minutes} minutes.`,
    "",
    "If you didn't try to create a Vendora account, you can ignore this email."
  ].join("\n")
});

export const passwordResetMessage = (to: string, name: string, link: string, minutes: number): EmailMessage => ({
  to,
  kind: "password-reset",
  subject: "Reset your Vendora password",
  text: [
    `Hi ${name},`,
    "",
    "We got a request to reset your Vendora password. Choose a new one here:",
    link,
    "",
    `The link expires in ${minutes} minutes and works once.`,
    "If you didn't ask for this, you can ignore this email. Your password won't change."
  ].join("\n")
});

export const passwordChangedMessage = (to: string, name: string, appUrl: string): EmailMessage => ({
  to,
  kind: "password-changed",
  subject: "Your Vendora password was changed",
  text: [
    `Hi ${name},`,
    "",
    "Your Vendora password was just changed, and every other device was signed out.",
    "",
    "If this was you, there's nothing else to do.",
    `If it wasn't you, reset your password now: ${appUrl}/forgot-password`
  ].join("\n")
});

export const accountExistsMessage =(to: string, name: string, appUrl: string): EmailMessage => ({
  to,
  kind: "account-exists",
  subject: "Someone tried to create a Vendora account with your email",
  text: [
    `Hi ${name},`,
    "",
    "Someone (maybe you) tried to create a new Vendora account with this email address, but you already have one.",
    "",
    `Sign in: ${appUrl}/sign-in`,
    `Forgot your password? ${appUrl}/forgot-password`,
    "",
    "If it wasn't you, you don't need to do anything. Your account is safe."
  ].join("\n")
});
