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

export const twoFactorEnabledMessage = (to: string, name: string, appUrl: string): EmailMessage => ({
  to,
  kind: "two-factor-enabled",
  subject: "Two-step verification is on",
  text: [
    `Hi ${name},`,
    "",
    "Two-step verification was just turned on for your Vendora account. From now on you'll enter a code from your authenticator app when you sign in.",
    "",
    `If this wasn't you, reset your password now (${appUrl}/forgot-password) and contact Vendora support.`
  ].join("\n")
});

export const twoFactorDisabledMessage = (to: string, name: string, appUrl: string): EmailMessage => ({
  to,
  kind: "two-factor-disabled",
  subject: "Two-step verification was turned off",
  text: [
    `Hi ${name},`,
    "",
    "Two-step verification was just turned off for your Vendora account, and no device is trusted anymore.",
    "",
    `If this wasn't you, reset your password now (${appUrl}/forgot-password) and contact Vendora support.`
  ].join("\n")
});

export const backupCodeUsedMessage = (to: string, name: string, left: number, appUrl: string): EmailMessage => ({
  to,
  kind: "backup-code-used",
  subject: "A backup code was used to sign in",
  text: [
    `Hi ${name},`,
    "",
    `A backup code was just used to sign in to your Vendora account. You have ${left} left.`,
    ...(left <= 3 ? ["Get new codes in Security settings before you run out."] : []),
    "",
    `If this wasn't you, reset your password now (${appUrl}/forgot-password) and contact Vendora support.`
  ].join("\n")
});

export const confirmCodeMessage = (to: string, code: string, minutes: number): EmailMessage => ({
  to,
  kind: "confirm-code",
  subject: "Your Vendora confirmation code",
  text: [
    "Hi,",
    "",
    `Your code to confirm it's you is ${code}. It expires in ${minutes} minutes.`,
    "We ask for this before sensitive changes to your account.",
    "",
    "If you didn't ask for it, someone may be using your account. Sign out of all other devices in Security settings."
  ].join("\n")
});

export const emailChangeCodeMessage = (to: string, code: string, minutes: number): EmailMessage => ({
  to,
  kind: "email-change-code",
  subject: "Confirm your new Vendora email address",
  text: [
    "Hi,",
    "",
    `Your code to use this address for your Vendora account is ${code}. It expires in ${minutes} minutes.`,
    "",
    "If you didn't ask for this, you can ignore this email."
  ].join("\n")
});

export const emailChangedNoticeMessage = (to: string, name: string, newEmailMasked: string): EmailMessage => ({
  to,
  kind: "email-changed",
  subject: "Your Vendora email address was changed",
  text: [
    `Hi ${name},`,
    "",
    `The email address for your Vendora account was just changed to ${newEmailMasked}. We'll send account emails there from now on.`,
    "",
    "If this wasn't you, contact Vendora support right away by replying to this email."
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
