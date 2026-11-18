import type { Logger } from "./logger.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** What kind of email this is, e.g. "verify-email" (for logs and tests). */
  kind: string;
}

/** Everything that sends email goes through this, so the provider can change without touching sign-in code. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Development and tests only: keeps the last 100 emails in memory and prints
 * them in the API terminal, so you can copy the code. The config refuses it in
 * production, because the log would contain sign-in codes.
 */
export class DevOutbox implements EmailSender {
  readonly sent: EmailMessage[] = [];

  constructor(private readonly logger?: Logger) {}

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    if (this.sent.length > 100) this.sent.shift();
    this.logger?.info({ email: { to: message.to, kind: message.kind } }, `DEV OUTBOX: "${message.subject}"\n${message.text}`);
  }

  /** The newest email sent to this address. */
  lastTo(to: string): EmailMessage | undefined {
    return this.sent.findLast((m) => m.to === to);
  }
}
