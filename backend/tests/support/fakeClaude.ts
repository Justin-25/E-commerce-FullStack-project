import { randomUUID } from "node:crypto";
import type { BetaContentBlock, BetaStopReason } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { AiAbortedError, usageOf, type AiModel, type AiRequest, type AiResponse } from "../../src/lib/ai.js";

/** One scripted reply: what Claude "says", or an error it throws. A function can look at the request first. */
export type Reply = { content: BetaContentBlock[]; stopReason?: BetaStopReason; model?: string; tokens?: { input?: number; output?: number }; droppedThinking?: number } | Error;
export type Step = Reply | ((request: AiRequest) => Reply | Promise<Reply>);

/**
 * A stand-in for Claude in tests (no network, no cost): it answers with the scripted replies in order,
 * streams their text in small pieces like the real API, and keeps a deep copy of every request it got,
 * so tests can check exactly what was sent (the transcript, the tool results, that no address leaked).
 */
export class FakeClaude implements AiModel {
  readonly name = "claude-opus-5-5";
  readonly requests: AiRequest[] = [];
  /**
   * Checks that failed inside a scripted step. The assistant turns any error from Claude into a polite chat
   * message, which would hide a failed `expect` there, so tests check this list after each run.
   */
  readonly stepErrors: unknown[] = [];
  private readonly script: Step[] = [];
  /** Called after each streamed piece; a test can abort the request here to simulate a closed chat. */
  onPiece: (() => void) | null = null;

  reply(...steps: Step[]) {
    this.script.push(...steps);
    return this;
  }

  get pending() {
    return this.script.length;
  }

  reset() {
    this.requests.length = 0;
    this.stepErrors.length = 0;
    this.script.length = 0;
    this.onPiece = null;
  }

  async stream(request: AiRequest, { onText, signal }: { onText: (delta: string) => void; signal: AbortSignal }): Promise<AiResponse> {
    this.requests.push(structuredClone(request));
    const step = this.script.shift();
    if (!step) throw new Error("FakeClaude: no reply scripted for this request");
    let reply: Reply;
    try {
      reply = typeof step === "function" ? await step(request) : step;
    } catch (err) {
      this.stepErrors.push(err);
      throw err;
    }
    if (reply instanceof Error) throw reply;
    for (const block of reply.content) {
      if (block.type !== "text") continue;
      for (const piece of block.text.match(/[\s\S]{1,12}/g) ?? []) {
        if (signal.aborted) throw new AiAbortedError();
        onText(piece);
        this.onPiece?.();
      }
    }
    if (signal.aborted) throw new AiAbortedError();
    const stopReason = reply.stopReason ?? (reply.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
    const model = reply.model ?? this.name;
    const usage = usageOf(
      { model, usage: { input_tokens: reply.tokens?.input ?? 1000, output_tokens: reply.tokens?.output ?? 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations: null } as never },
      this.name
    );
    return { content: reply.content, stopReason, model, usage, droppedThinking: reply.droppedThinking ?? 0 };
  }
}

// --- content blocks, shaped like the API's ---------------------------------------------

export const text = (t: string) => ({ type: "text", text: t, citations: null }) as BetaContentBlock;
/** A thinking block as Opus 5.5 returns it by default (no visible text, a signature). */
export const thinking = () => ({ type: "thinking", thinking: "", signature: `sig-${randomUUID()}` }) as BetaContentBlock;
export const toolUse = (name: string, input: Record<string, unknown>, id = `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`) =>
  ({ type: "tool_use", id, name, input }) as BetaContentBlock;
export const fallback = (from = "claude-opus-5-5", to = "claude-opus-4-8") => ({ type: "fallback", from: { model: from }, to: { model: to } }) as unknown as BetaContentBlock;

/** Claude asks for these lookups (with a thinking block first, like the real model). */
export const lookup = (...calls: BetaContentBlock[]): Reply => ({ content: [thinking(), ...calls] });
/** Claude's final answer. */
export const answer = (t: string): Reply => ({ content: [thinking(), text(t)] });
