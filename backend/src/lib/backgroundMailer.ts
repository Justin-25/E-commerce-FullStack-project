import type { EmailMessage, EmailSender } from "./email.js";
import type { Logger } from "./logger.js";

/**
 * Sends emails without making the request wait, so response times don't reveal
 * whether an email went out (i.e. whether an account exists). Failures are
 * logged; `drain()` lets a shutting-down server finish what's in flight.
 */
export class BackgroundMailer {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly sender: EmailSender,
    private readonly logger?: Logger
  ) {}

  send(message: EmailMessage): void {
    const sending: Promise<void> = this.sender
      .send(message)
      .catch((err: unknown) => this.logger?.error({ err, kind: message.kind }, "email could not be sent"))
      .finally(() => this.pending.delete(sending));
    this.pending.add(sending);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}
