import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";

/**
 * Rules for the transcript we keep and replay to Claude. It is append-only: every earlier message goes back
 * exactly as stored, because Claude's thinking blocks are only valid in the exact conversation that produced
 * them (and the prompt cache matches the history token for token).
 */

/** Blocks a model writes for itself; after a mid-answer switch to the fallback model, the declined part's ones can't be sent back. */
const ECHO_SAFE_BEFORE_SWITCH = new Set(["text", "fallback"]);

/**
 * What of an answer may be stored and sent back on later turns. Normally all of it. After a safety check
 * declined part-way and the fallback model continued, the blocks BEFORE the last `fallback` marker keep only
 * their text: thinking and tool calls from the declined part are left out (Anthropic's rule), and the marker
 * stays exactly where it was.
 */
export function echoable(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const last = content.map((b) => b.type).lastIndexOf("fallback");
  const kept = last < 0 ? content : content.filter((b, i) => i >= last || ECHO_SAFE_BEFORE_SWITCH.has(b.type));
  return kept as BetaContentBlockParam[];
}

/** The blocks of the model that finally answered: everything after the last `fallback` marker (all of it without one). */
export function finalPart(content: BetaContentBlock[]): BetaContentBlock[] {
  const last = content.map((b) => b.type).lastIndexOf("fallback");
  return last < 0 ? content : content.slice(last + 1);
}

export function toolCalls(content: BetaContentBlock[]): BetaToolUseBlock[] {
  return finalPart(content).filter((b): b is BetaToolUseBlock => b.type === "tool_use");
}

/**
 * Tool calls the previous turn never answered (the answer was interrupted, or stopped at the lookup limit).
 * The API requires a result for each, first thing in the next user message, so the next question starts with
 * "not run" results for them.
 */
export function unansweredToolCalls(messages: BetaMessageParam[]): string[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || typeof last.content === "string") return [];
  return last.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
}
