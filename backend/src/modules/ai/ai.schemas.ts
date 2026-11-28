import { z } from "zod";
import { CHAT_SCOPES, QUESTION_MAX_CHARS } from "./assistant.service.js";

/** Which kind of chat: the shopping assistant (default) or "Ask your data" in Seller Center. */
const scope = z.enum(CHAT_SCOPES, { error: "Unknown kind of chat" });
export const scopeQuerySchema = z.object({ scope: scope.default("shopper") });

export const conversationIdSchema = z.object({ id: z.uuid({ error: "Chat not found" }) });

export const startSchema = z
  .object({
    scope: scope.default("shopper"),
    /** "Ask about this product" (shopper chats): the chat starts knowing which product page it came from. */
    productId: z.uuid({ error: "Product not found" }).optional()
  })
  .strict()
  .refine((v) => v.scope === "shopper" || v.productId === undefined, { error: "Only shopper chats start from a product", path: ["productId"] });

export const questionSchema = z
  .object({
    question: z
      .string({ error: "Type a question" })
      .trim()
      .min(1, { error: "Type a question" })
      .max(QUESTION_MAX_CHARS, { error: `Use ${QUESTION_MAX_CHARS} characters or fewer` })
  })
  .strict();
