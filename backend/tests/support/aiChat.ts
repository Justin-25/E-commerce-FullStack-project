import type { BetaContentBlockParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { expect } from "vitest";
import type { AiRequest } from "../../src/lib/ai.js";
import type { Browser } from "./browser.js";

/** Chat steps for Vendora AI tests (the fake Claude replies; see fakeClaude.ts). */
export const CHATS = "/api/v1/ai/conversations";

export type ChatEvent = { type: string } & Record<string, unknown>;

/** The server-sent events of an answer. */
export function eventsOf(res: { text: string }): ChatEvent[] {
  return res.text
    .split("\n\n")
    .filter((chunk) => chunk.trim())
    .map((chunk) => ({ type: /^event: (.+)$/m.exec(chunk)?.[1] ?? "?", ...(JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? "{}") as object) }));
}

/** Everything the answer said. */
export const said = (events: ChatEvent[]) => events.filter((e) => e.type === "text").map((e) => e.delta).join("");

export async function newChat(b: Browser, body: object = {}): Promise<string> {
  const res = await b.post(CHATS, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.conversation.id as string;
}

export async function ask(b: Browser, id: string, question: string) {
  const res = await b.post(`${CHATS}/${id}/messages`, { question });
  return { res, events: res.status === 200 ? eventsOf(res) : [] };
}

/** The tool results Claude received in a request (its last user message). */
export function toolResults(req: AiRequest): BetaToolResultBlockParam[] {
  const last = req.messages.at(-1);
  return (last?.content as BetaContentBlockParam[]).filter((b): b is BetaToolResultBlockParam => b.type === "tool_result");
}

export const resultJson = <T = Record<string, unknown>>(r: BetaToolResultBlockParam) => JSON.parse(r.content as string) as T;
