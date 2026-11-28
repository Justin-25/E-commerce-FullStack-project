import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaStopReason,
  BetaTool
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Logger } from "./logger.js";

/** What Vendora decides for one request; the model client adds the model, effort and API settings. */
export interface AiRequest {
  system: string;
  tools: BetaTool[];
  messages: BetaMessageParam[];
  /** An opaque id for Anthropic's abuse detection: a keyed hash, never a name or email. */
  userKey: string;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** What the request cost, in millionths of a US dollar (for the daily budget). */
  costMicroUsd: number;
}

export interface AiResponse {
  content: BetaContentBlock[];
  stopReason: BetaStopReason | null;
  /** The model that wrote the answer (another one if a safety check declined and the fallback answered). */
  model: string;
  usage: AiUsage;
  /**
   * Thinking blocks the API dropped because the replayed history no longer matched (a deploy changed the
   * instructions mid-chat). Normally 0: transcripts are append-only.
   */
  droppedThinking: number;
}

/** The person closed the chat (or the page) while the answer was being written. */
export class AiAbortedError extends Error {
  constructor() {
    super("the answer was stopped");
    this.name = "AiAbortedError";
  }
}

/** Claude didn't answer (overloaded, rate-limited, network, a bad request): the chat says "try again in a minute". */
export class AiUnavailableError extends Error {
  constructor(
    readonly status: number | undefined,
    cause: unknown
  ) {
    super(`Claude didn't answer${status ? ` (HTTP ${status})` : ""}`, { cause });
    this.name = "AiUnavailableError";
  }
}

/** The one thing the assistant needs from Claude: a streamed answer. Tests use a scripted fake. */
export interface AiModel {
  readonly name: string;
  stream(request: AiRequest, options: { onText: (delta: string) => void; signal: AbortSignal }): Promise<AiResponse>;
}

/**
 * Prices in US dollars per million tokens (Anthropic's list prices, 5-minute cache writes), used only for the
 * daily budget. A model that isn't listed is counted at a high price, so the budget errs on the safe side.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
};
const UNLISTED = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

export function priceOf(model: string) {
  return PRICES[model] ?? UNLISTED;
}

interface Tokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
}

/**
 * Token counts and cost of one response. With a fallback, `usage.iterations` lists every attempt (each billed
 * at its own model's price) and the top-level usage covers only the last one, so the attempts are added up.
 */
export function usageOf(message: Pick<BetaMessage, "usage" | "model">, requestedModel: string): AiUsage {
  const attempts: { model: string; tokens: Tokens }[] = message.usage.iterations?.length
    ? message.usage.iterations.map((it) => ({ model: ("model" in it && it.model) || requestedModel, tokens: it }))
    : [{ model: message.model || requestedModel, tokens: message.usage }];
  const usage: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicroUsd: 0 };
  for (const { model, tokens } of attempts) {
    const price = priceOf(model);
    const read = tokens.cache_read_input_tokens ?? 0;
    const write = tokens.cache_creation_input_tokens ?? 0;
    usage.inputTokens += tokens.input_tokens;
    usage.outputTokens += tokens.output_tokens;
    usage.cacheReadTokens += read;
    usage.cacheWriteTokens += write;
    // $ per million tokens × tokens = millionths of a dollar.
    usage.costMicroUsd += tokens.input_tokens * price.input + tokens.output_tokens * price.output + read * price.cacheRead + write * price.cacheWrite;
  }
  usage.costMicroUsd = Math.ceil(usage.costMicroUsd);
  return usage;
}

/** Room for the (short, low-effort) thinking plus the answer; only the tokens actually used are billed. */
const MAX_TOKENS = 12_000;
const BETAS = [
  // Our transcript is append-only; if a deploy changes the instructions mid-chat, drop old thinking instead of failing.
  "thinking-binding-controls-2026-08-01"
] as const;

/**
 * Claude through Anthropic's SDK (Messages API, streamed). Settings:
 * - adaptive thinking at low effort: chat answers need little deliberation, and it keeps answers fast and cheap;
 * - prompt caching of the whole prefix (instructions, tools, the chat so far), so each turn re-reads it at ~5% of the price;
 * - "fallbacks: default": if a safety check declines a harmless question, Anthropic retries it on another model
 *   instead of failing (Haiku has no fallback, so it isn't sent there).
 */
export class AnthropicModel implements AiModel {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly name: string,
    private readonly logger?: Logger
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async stream(request: AiRequest, { onText, signal }: { onText: (delta: string) => void; signal: AbortSignal }): Promise<AiResponse> {
    const fallback = !this.name.startsWith("claude-haiku");
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.name,
          max_tokens: MAX_TOKENS,
          system: request.system,
          tools: request.tools,
          messages: request.messages,
          cache_control: { type: "ephemeral" },
          thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
          output_config: { effort: "low" },
          metadata: { user_id: request.userKey },
          betas: fallback ? [...BETAS, "server-side-fallback-2026-07-01"] : [...BETAS],
          ...(fallback ? { fallbacks: "default" as const } : {})
        },
        { signal }
      );
      stream.on("text", (delta) => onText(delta));
      const message = await stream.finalMessage();
      const dropped = (message.input_transformations ?? []).filter((t) => t.type === "thinking_dropped");
      if (message.stop_reason === "refusal") this.logger?.warn({ model: message.model, details: message.stop_details }, "Claude declined a question");
      return {
        content: message.content,
        stopReason: message.stop_reason,
        model: message.model,
        usage: usageOf(message, this.name),
        droppedThinking: dropped.length
      };
    } catch (err) {
      if (signal.aborted || err instanceof Anthropic.APIUserAbortError) throw new AiAbortedError();
      throw new AiUnavailableError(err instanceof Anthropic.APIError ? err.status : undefined, err);
    }
  }
}
