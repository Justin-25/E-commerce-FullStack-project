import { Router, type Request, type RequestHandler, type Response } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import type { Config } from "../../config/env.js";
import { randomToken, sha256Hex } from "../../lib/crypto.js";
import { privateNoStore } from "../../lib/httpCache.js";
import type { AuthGuards } from "../../middleware/auth.js";
import { conversationIdSchema, questionSchema, scopeQuerySchema, startSchema } from "./ai.schemas.js";
import { KEEP_DAYS, type AssistantService, type ChatEvent, type Requester } from "./assistant.service.js";

const VISITOR_COOKIE_MAX_AGE_MS = KEEP_DAYS * 24 * 60 * 60 * 1000;
const VISITOR_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Vendora AI. Shopper chats (8a) work signed in or out:
 * - signed in, chats belong to the account and can use its orders and cart;
 * - signed out, a chat belongs to this browser through a random httpOnly cookie (only its hash is stored)
 *   and can only answer product and policy questions.
 * Seller chats (8b-1, `scope: "seller"`, "Ask your data") need Seller Center access and see only the seller's store.
 * Changes are CSRF-checked app-wide. Answers stream as server-sent events (POST …/messages); every limit
 * and permission is checked before the stream opens, so those come back as normal JSON errors.
 */
export function aiRouter({ assistant, guards, config }: { assistant: AssistantService; guards: AuthGuards; config: Pick<Config, "NODE_ENV"> }): Router {
  const router = Router();
  const secure = config.NODE_ENV === "production";
  // __Host-: browsers only accept it over HTTPS, from this host, for the whole site.
  const cookieName = secure ? "__Host-vd_ai" : "vd_ai";

  const visitorToken = (req: Request): string | null => {
    const value: unknown = req.cookies?.[cookieName];
    return typeof value === "string" && VISITOR_TOKEN.test(value) ? value : null;
  };
  const requester = (req: Request, token = visitorToken(req)): Requester => ({
    userId: req.auth?.userId ?? null,
    visitorHash: token ? sha256Hex(token) : null,
    ipKey: ipKeyGenerator(req.ip ?? "unknown", 56)
  });
  const live: RequestHandler = (_req, res, next) => {
    privateNoStore(res);
    next();
  };

  router.use("/ai", guards.authenticate, live);

  router.get("/ai/status", async (req, res) => {
    res.json(await assistant.status(requester(req), scopeQuerySchema.parse(req.query).scope));
  });

  router.get("/ai/conversations", async (req, res) => {
    res.json({ conversations: await assistant.list(requester(req), scopeQuerySchema.parse(req.query).scope) });
  });

  router.post("/ai/conversations", async (req, res) => {
    const { scope, productId } = startSchema.parse(req.body ?? {});
    let token = visitorToken(req);
    if (!req.auth && !token && scope === "shopper") {
      token = randomToken(32);
      res.cookie(cookieName, token, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: VISITOR_COOKIE_MAX_AGE_MS });
    }
    const conversation = await assistant.start(requester(req, token), { scope, ...(productId ? { productId } : {}) });
    res.status(201).json({ conversation });
  });

  router.get("/ai/conversations/:id", async (req, res) => {
    res.json(await assistant.get(requester(req), conversationIdSchema.parse(req.params).id));
  });

  router.delete("/ai/conversations/:id", async (req, res) => {
    await assistant.remove(requester(req), conversationIdSchema.parse(req.params).id);
    res.status(204).end();
  });

  router.post("/ai/conversations/:id/messages", async (req, res) => {
    const { id } = conversationIdSchema.parse(req.params);
    const { question } = questionSchema.parse(req.body);
    const turn = await assistant.begin(requester(req), id, question); // errors here are normal JSON responses

    const stop = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) stop.abort(); // the chat was closed: stop paying for an answer nobody reads
    });
    openStream(res);
    await assistant.answer(turn, (event) => send(res, event), stop.signal);
    res.end();
  });

  return router;
}

function openStream(res: Response) {
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "private, no-store",
    // Proxies (nginx, Render) must pass each event on at once instead of buffering the answer.
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();
}

/** One server-sent event: `event: text` / `data: {"delta":"…"}`. */
function send(res: Response, { type, ...data }: ChatEvent) {
  if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}
