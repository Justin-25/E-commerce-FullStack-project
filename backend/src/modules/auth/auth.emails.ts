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

// --- Support's account actions (milestone 7c) ---

/** Support started "Reset two-step verification": nothing happens until the owner confirms from their inbox. */
export const twoFactorResetRequestMessage = (to: string, name: string, link: string, hours: number): EmailMessage => ({
  to,
  kind: "two-factor-reset-request",
  subject: "Confirm: reset two-step verification on your Vendora account",
  text: [
    `Hi ${name},`,
    "",
    "Vendora support started a reset of two-step verification on your account, after you told us you lost your authenticator app and your backup codes. If that was you, confirm here:",
    link,
    "",
    `The link works once, for ${hours} hours. After the reset you sign in with your password, then set up two-step verification again.`,
    "If you didn't ask for this, ignore this email: nothing changes. Please also tell Vendora support."
  ].join("\n")
});

export const twoFactorResetDoneMessage = (to: string, name: string, appUrl: string): EmailMessage => ({
  to,
  kind: "two-factor-reset",
  subject: "Two-step verification was reset",
  text: [
    `Hi ${name},`,
    "",
    "As you confirmed, two-step verification is off on your Vendora account. You were signed out everywhere, and no device is trusted anymore.",
    `Sign in and set it up again: ${appUrl}/account/security (sellers need it before they can sell).`,
    "",
    `If this wasn't you, reset your password now (${appUrl}/forgot-password) and contact Vendora support.`
  ].join("\n")
});

export const accountSuspendedMessage = (to: string, name: string, reason: string): EmailMessage => ({
  to,
  kind: "account-suspended",
  subject: "Your Vendora account is suspended",
  text: [
    `Hi ${name},`,
    "",
    "Your Vendora account has been suspended, and you were signed out everywhere.",
    `Why: ${reason}`,
    "",
    "If you think this is a mistake, reply to this email or contact Vendora support."
  ].join("\n")
});

export const accountReactivatedMessage = (to: string, name: string, appUrl: string): EmailMessage => ({
  to,
  kind: "account-reactivated",
  subject: "Your Vendora account is active again",
  text: [`Hi ${name},`, "", "Your Vendora account is active again. You can sign in as usual.", "", `Sign in: ${appUrl}/sign-in`].join("\n")
});

export const backupCodeUsedMessage =(to: string, name: string, left: number, appUrl: string): EmailMessage => ({
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

export const googleConnectedMessage = (to: string, name: string, googleEmail: string, appUrl: string): EmailMessage => ({
  to,
  kind: "google-connected",
  subject: "Google sign-in was connected",
  text: [
    `Hi ${name},`,
    "",
    `You can now sign in to Vendora with the Google account ${googleEmail}.`,
    "",
    `If this wasn't you, reset your password now (${appUrl}/forgot-password) and disconnect Google in Security settings.`
  ].join("\n")
});

export const googleDisconnectedMessage = (to: string, name: string, appUrl: string): EmailMessage => ({
  to,
  kind: "google-disconnected",
  subject: "Google sign-in was disconnected",
  text: [
    `Hi ${name},`,
    "",
    "Google sign-in was just disconnected from your Vendora account. You can still sign in with your email and password.",
    "",
    `If this wasn't you, reset your password now (${appUrl}/forgot-password).`
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
