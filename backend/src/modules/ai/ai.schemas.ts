import { z } from "zod";
import { QUESTION_MAX_CHARS } from "./assistant.service.js";

export const conversationIdSchema = z.object({ id: z.uuid({ error: "Chat not found" }) });

export const startSchema = z
  .object({
    /** "Ask about this product": the chat starts knowing which product page it came from. */
    productId: z.uuid({ error: "Product not found" }).optional()
  })
  .strict();

export const questionSchema = z
  .object({
    question: z
      .string({ error: "Type a question" })
      .trim()
      .min(1, { error: "Type a question" })
      .max(QUESTION_MAX_CHARS, { error: `Use ${QUESTION_MAX_CHARS} characters or fewer` })
  })
  .strict();
