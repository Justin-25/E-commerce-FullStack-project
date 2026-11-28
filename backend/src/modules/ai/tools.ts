import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";

/** Whose data a lookup may read: the chat's owner (never the person who happens to be asking). */
export interface ToolContext {
  /** The account that owns the chat; null for a signed-out visitor's chat (no account data at all). */
  userId: string | null;
}

/**
 * One lookup Claude can ask for. Claude only picks the tool and its arguments; our code checks the arguments
 * (zod) and runs a fixed, read-only query limited to `ToolContext`. No tool writes anything, and Claude never
 * writes SQL.
 */
export interface AiTool<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  /** What the chat shows while it runs ("Searching products…"). */
  status: string;
  run(input: I, ctx: ToolContext): Promise<unknown>;
}

export const defineTool = <S extends z.ZodType>(tool: { name: string; description: string; input: S; status: string; run(input: z.output<S>, ctx: ToolContext): Promise<unknown> }) =>
  tool as unknown as AiTool;

/**
 * The tool list sent to Claude. Built once at startup and identical on every request: changing the tools in
 * the middle of a chat would invalidate Claude's earlier thinking.
 */
export function toolDefinitions(tools: AiTool[]): BetaTool[] {
  return tools.map((t) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as BetaTool["input_schema"],
      // Inputs stream as they're written; our own zod check validates them before anything runs.
      eager_input_streaming: true
    };
  });
}

/** Seller- and shopper-written text: Claude is told it's data, and it's cut short to keep answers cheap. */
export const clip = (text: string | null | undefined, max: number) => {
  const t = (text ?? "").trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
};
