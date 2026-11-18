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

export const accountExistsMessage = (to: string, name: string, appUrl: string): EmailMessage => ({
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
