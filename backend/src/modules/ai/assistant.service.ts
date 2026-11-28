import type { BetaContentBlockParam, BetaMessageParam, BetaTool, BetaToolResultBlockParam, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AiConversation, AiRole, AiScope, Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { AiAbortedError, AiUnavailableError, type AiModel, type AiUsage } from "../../lib/ai.js";
import { hmacHex } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import type { CartService } from "../cart/cart.service.js";
import type { CatalogService } from "../catalog/catalog.service.js";
import type { OrderService } from "../orders/orders.service.js";
import { sellerStore } from "../seller/access.js";
import type { PayoutService } from "../seller/payouts.service.js";
import type { VisitService } from "../stores/visits.js";
import { linkedRefs, resolveCards, type CardRefs, type Cards } from "./cards.js";
import { QUESTIONS_PER_DAY, type AiLimits, type Asker } from "./limits.js";
import { SELLER_SYSTEM, SHOPPER_SYSTEM } from "./prompts.js";
import { sellerTools } from "./sellerTools.js";
import { shopperTools } from "./shopperTools.js";
import { clip, toolDefinitions, WithTable, type AiTool, type AnswerTable, type ToolContext } from "./tools.js";
import { echoable, toolCalls, unansweredToolCalls } from "./transcript.js";

export const MAX_QUESTIONS_PER_CHAT = 20;
/** Lookup rounds per question; after the last one Claude must answer with what it has. */
export const MAX_LOOKUP_ROUNDS = 4;
export const QUESTION_MAX_CHARS = 1000;
/** Chats are deleted this long after their last message. */
export const KEEP_DAYS = 30;
/** An answer normally takes seconds; a chat stuck "busy" (a server stopped mid-answer) frees itself after this. */
const BUSY_MS = 3 * 60_000;
const RECENT_CHATS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const LAST_ROUND_NOTE = "That was the last lookup for this question: answer now with what you have, without calling more tools.";
/** Tables an answer may show (the rest of a lookup's tables stay unshown). */
const MAX_TABLES = 3;
const TABLE_MARKER = /\[\[table:([a-z0-9-]{1,20})\]\]/gi;
const CANNED = {
  cutOff: "Sorry, I couldn't finish that answer. Please try asking again, a bit more specifically.",
  tooManyLookups: "Sorry, that took more lookups than I'm allowed for one question. Try asking about one thing at a time.",
  empty: "Sorry, I couldn't come up with an answer. Please try asking another way.",
  unavailable: "Vendora AI is busy right now. Please try again in a minute.",
  failed: "Something went wrong while answering. Please try again."
};

const NOW_FORMAT = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

/** What the chat receives while an answer is written (sent as server-sent events). */
export type ChatEvent =
  | { type: "status"; text: string }
  | { type: "text"; delta: string }
  /** Clear the text shown so far (the answer was declined or cut off; a short message follows). */
  | { type: "discard" }
  | ({ type: "cards" } & Cards)
  | { type: "done"; messageId: string; suggestions: string[]; questionsLeftToday: number; questionsLeftInChat: number }
  | { type: "error"; message: string };

/** The person using the chat: their account if signed in, this browser's visitor cookie (hashed), and their network address. */
export interface Requester {
  userId: string | null;
  visitorHash: string | null;
  /** For the signed-out daily limit: the address, IPv6 grouped by /56. */
  ipKey: string;
}

/** The kinds of chat: the shopping assistant (8a) and "Ask your data" in Seller Center (8b-1). */
export const CHAT_SCOPES = ["shopper", "seller"] as const;
export type ChatScope = (typeof CHAT_SCOPES)[number];
const SCOPE: Record<ChatScope, AiScope> = { shopper: "SHOPPER", seller: "SELLER" };

/** What a chat's owner may do right now, checked in the database for every question. */
interface Access {
  /** Whose data the lookups read. */
  ctx: ToolContext;
  /** Vendora's lines for the question's <context> block. */
  context: string[];
}

/** A question that passed every check and holds the chat; `answer` writes the reply. */
export interface Turn {
  conversation: AiConversation;
  access: Access;
  question: string;
  questionsLeftToday: number;
  questionsLeftInChat: number;
}

/** One kind of chat: fixed instructions and lookups (identical for the whole life of a chat), and who may use it. */
interface Scope {
  system: string;
  tools: Map<string, AiTool>;
  definitions: BetaTool[];
  /** Seller and admin chats: 50 questions a day per person, counted apart from shopping. */
  staff: boolean;
  declined: string;
  access(c: { userId: string | null }): Promise<Access>;
  suggestions(cards: Cards, signedIn: boolean): string[];
}

const notFound = () => new AppError(404, "NOT_FOUND", "This chat doesn't exist or was deleted.");
const signInFirst = () => new AppError(401, "UNAUTHORIZED", "Please sign in to continue.");
const aiOff = () => new AppError(503, "SERVICE_UNAVAILABLE", "Vendora AI isn't available right now.", { details: { reason: "ai_off" } });
const chatFull = () =>
  new AppError(409, "CONFLICT", `This chat has reached ${MAX_QUESTIONS_PER_CHAT} questions. Start a new chat to keep asking.`, { details: { reason: "chat_full" } });
const busy = () => new AppError(409, "CONFLICT", "Vendora AI is still answering your last question.", { details: { reason: "answer_in_progress" } });

/**
 * Vendora AI (milestone 8a: the shopper assistant). Claude answers; our code decides what it may see.
 *
 * Each question runs a small loop: Claude streams its answer and may ask for lookups (tools); we check each
 * request, run it with the chat OWNER's permissions, send the result back, and repeat (at most
 * MAX_LOOKUP_ROUNDS times). Every step is saved in order and the whole transcript is replayed exactly on the
 * next question (append-only), because Claude's thinking is only valid in the conversation that produced it.
 *
 * Costs are bounded before anything is sent: questions per person per day, a site-wide daily budget,
 * 20 questions per chat, one answer at a time per chat, and chats deleted after 30 days.
 */
export class AssistantService {
  private readonly scopes: Partial<Record<AiScope, Scope>>;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      /** Null when ANTHROPIC_API_KEY isn't set: the assistant is off. */
      model: AiModel | null;
      limits: AiLimits;
      catalog: CatalogService;
      orders: OrderService;
      cart: CartService;
      payouts: PayoutService;
      visits: VisitService;
      /** CODE_HASH_SECRET: for the opaque user id sent to Anthropic. */
      secret: string;
      logger?: Logger;
      now?: () => Date;
    }
  ) {
    const kind = (system: string, tools: AiTool[], rest: Omit<Scope, "system" | "tools" | "definitions">): Scope => ({
      system,
      tools: new Map(tools.map((t) => [t.name, t])),
      definitions: toolDefinitions(tools),
      ...rest
    });
    this.scopes = {
      SHOPPER: kind(SHOPPER_SYSTEM, shopperTools(deps), {
        staff: false,
        declined: "Sorry, I can't help with that one. I can help you find products, check your orders or explain Vendora's policies.",
        access: async (c) => ({ ctx: { userId: c.userId }, context: [c.userId ? "The shopper is signed in." : "The shopper is not signed in: no orders or cart in this chat."] }),
        suggestions: shopperSuggestions
      }),
      SELLER: kind(SELLER_SYSTEM, sellerTools({ ...deps, ...(deps.now ? { now: deps.now } : {}) }), {
        staff: true,
        declined: "Sorry, I can't help with that one. I can answer questions about your store's sales, stock, orders, payouts, reviews and visits.",
        // Seller Center's own door, every question: a seller who lost their store or turned off 2FA can't keep asking.
        access: async (c) => {
          if (!c.userId) throw notFound();
          const store = await sellerStore(this.deps.prisma, c.userId, { write: false });
          const status = store.status === "SUSPENDED" ? " It is suspended: hidden from shoppers." : store.status === "PENDING" ? " It is waiting for Vendora's review." : "";
          return { ctx: { userId: c.userId, storeId: store.id }, context: [`Seller Center chat for the store "${store.name}".${status} Lookups only see this store.`] };
        },
        suggestions: () => ["Best sellers this month?", "What's running low?", "Compare with last week"]
      })
    };
  }

  private scope(s: AiScope): Scope {
    const scope = this.scopes[s];
    if (!scope) throw new Error(`no assistant for scope ${s}`);
    return scope;
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private model(): AiModel {
    if (!this.deps.model) throw aiOff();
    return this.deps.model;
  }

  /** The daily count follows the person asking: their account, or (signed out) their network address. Seller and admin chats count apart. */
  private asker(req: Requester, scope: Scope): Asker {
    if (scope.staff && req.userId) return { kind: "user", userId: req.userId, perDay: QUESTIONS_PER_DAY.staff, bucket: "staff" };
    return req.userId ? { kind: "user", userId: req.userId, perDay: QUESTIONS_PER_DAY.shopper } : { kind: "visitor", ipKey: req.ipKey, perDay: QUESTIONS_PER_DAY.visitor };
  }

  /** A chat belongs to its account, or to the browser that started it signed out. Anyone else gets a 404. */
  private async owned(req: Requester, id: string): Promise<AiConversation> {
    const c = await this.deps.prisma.aiConversation.findUnique({ where: { id } });
    const mine = c && (c.userId ? c.userId === req.userId : c.visitorHash !== null && c.visitorHash === req.visitorHash);
    if (!c || !mine) throw notFound();
    return c;
  }

  // --- status and chats ----------------------------------------------------------

  /** Staff chats (seller, admin) need an account that may use them right now: 401 signed out, 403 otherwise. */
  private async ensureStaff(req: Requester, scope: Scope): Promise<void> {
    if (!scope.staff) return;
    if (!req.userId) throw signInFirst();
    await scope.access({ userId: req.userId });
  }

  /** For the chat panel: can it be used now, and how many questions are left today. */
  async status(req: Requester, kind: ChatScope = "shopper") {
    const scope = this.scope(SCOPE[kind]);
    await this.ensureStaff(req, scope);
    const asker = this.asker(req, scope);
    const base = { scope: kind, signedIn: req.userId !== null, questionsPerDay: asker.perDay, questionsPerChat: MAX_QUESTIONS_PER_CHAT };
    if (!this.deps.model) return { available: false, reason: "ai_off" as const, resting: false, questionsLeftToday: 0, resetsInSeconds: null, ...base };
    const [resting, left] = await Promise.all([this.deps.limits.isResting(), this.deps.limits.questionsLeft(asker)]);
    const reason = resting ? ("ai_resting" as const) : left === 0 ? ("ai_daily_limit" as const) : null;
    return { available: reason === null, reason, resting, questionsLeftToday: left, resetsInSeconds: reason ? this.deps.limits.secondsUntilReset() : null, ...base };
  }

  /**
   * A new chat. Shopper chats belong to this account (or, signed out, this browser) and can start from a product
   * page; seller chats need Seller Center access and always belong to the account.
   */
  async start(req: Requester, opts: { scope?: ChatScope; productId?: string }) {
    this.model();
    const kind = opts.scope ?? "shopper";
    const scope = this.scope(SCOPE[kind]);
    if (scope.staff) {
      await this.ensureStaff(req, scope);
      const c = await this.deps.prisma.aiConversation.create({ data: { scope: SCOPE[kind], userId: req.userId } });
      return this.summary(c);
    }
    if (!req.userId && !req.visitorHash) throw new AppError(400, "BAD_REQUEST", "Your browser didn't keep the chat cookie. Please allow cookies for this site.");
    if (opts.productId) await this.deps.catalog.product(opts.productId); // 404 unless it's on sale
    const c = await this.deps.prisma.aiConversation.create({
      data: { scope: "SHOPPER", productId: opts.productId ?? null, ...(req.userId ? { userId: req.userId } : { visitorHash: req.visitorHash }) }
    });
    return this.summary(c);
  }

  /** The latest chats of one kind: this account's (signed in) or this browser's (signed out, shopper chats only). */
  async list(req: Requester, kind: ChatScope = "shopper") {
    const scope = this.scope(SCOPE[kind]);
    if (scope.staff) await this.ensureStaff(req, scope);
    if (!req.userId && !req.visitorHash) return [];
    const rows = await this.deps.prisma.aiConversation.findMany({
      where: { scope: SCOPE[kind], ...(req.userId ? { userId: req.userId } : { visitorHash: req.visitorHash, userId: null }) },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: RECENT_CHATS
    });
    return rows.map((c) => this.summary(c));
  }

  /** One chat as the panel shows it: the questions and answers (lookup steps are internal), cards read live. */
  async get(req: Requester, id: string) {
    const c = await this.owned(req, id);
    const scope = this.scope(c.scope);
    if (scope.staff) await scope.access(c); // a seller who lost Seller Center access can't read its chats either
    const rows = await this.deps.prisma.aiMessage.findMany({
      where: { conversationId: id, text: { not: null } },
      orderBy: { seq: "asc" },
      select: { id: true, role: true, text: true, cards: true, createdAt: true }
    });
    const messages = await Promise.all(
      rows.map(async (m) => ({
        id: m.id,
        role: m.role === "USER" ? ("user" as const) : ("assistant" as const),
        text: m.text ?? "",
        cards: m.role === "ASSISTANT" && m.cards ? await resolveCards(this.deps, m.cards as unknown as CardRefs, c.userId) : null,
        createdAt: m.createdAt.toISOString()
      }))
    );
    return { conversation: this.summary(c), messages };
  }

  async remove(req: Requester, id: string): Promise<void> {
    await this.owned(req, id);
    await this.deps.prisma.aiConversation.deleteMany({ where: { id } });
  }

  private summary(c: AiConversation) {
    return {
      id: c.id,
      scope: c.scope.toLowerCase(),
      title: c.title,
      productId: c.productId,
      signedIn: c.userId !== null,
      questionCount: c.questionCount,
      questionsLeft: Math.max(0, MAX_QUESTIONS_PER_CHAT - c.questionCount),
      createdAt: c.createdAt.toISOString(),
      lastMessageAt: c.lastMessageAt.toISOString()
    };
  }

  /** Background job: chats untouched for 30 days are deleted with their messages. */
  async deleteOld(): Promise<number> {
    const now = this.now();
    const { count } = await this.deps.prisma.aiConversation.deleteMany({
      where: { lastMessageAt: { lt: new Date(now.getTime() - KEEP_DAYS * DAY_MS) }, OR: [{ busyUntil: null }, { busyUntil: { lt: now } }] }
    });
    return count;
  }

  // --- asking ---------------------------------------------------------------------

  /**
   * Every check before anything is sent to Claude (so they come back as normal errors, before the answer
   * stream opens): the chat is yours and not full, the assistant isn't resting, you have questions left today,
   * and no other answer is being written in this chat.
   */
  async begin(req: Requester, id: string, question: string): Promise<Turn> {
    this.model();
    const c = await this.owned(req, id);
    const scope = this.scope(c.scope);
    const access = await scope.access(c); // checked again for every question
    if (c.questionCount >= MAX_QUESTIONS_PER_CHAT) throw chatFull();
    if (c.busyUntil && c.busyUntil > this.now()) throw busy(); // a double click doesn't use a daily question
    await this.deps.limits.ensureBudget();
    const { left } = await this.deps.limits.countQuestion(this.asker(req, scope));
    const now = this.now();
    // One answer at a time, and never more than 20 questions, even when two arrive together.
    const claimed = await this.deps.prisma.aiConversation.updateMany({
      where: { id, questionCount: { lt: MAX_QUESTIONS_PER_CHAT }, OR: [{ busyUntil: null }, { busyUntil: { lte: now } }] },
      data: { busyUntil: new Date(now.getTime() + BUSY_MS), questionCount: { increment: 1 }, lastMessageAt: now, ...(c.title ? {} : { title: clip(question, 120) }) }
    });
    if (claimed.count === 0) {
      const fresh = await this.deps.prisma.aiConversation.findUnique({ where: { id }, select: { questionCount: true } });
      throw fresh && fresh.questionCount >= MAX_QUESTIONS_PER_CHAT ? chatFull() : busy();
    }
    return { conversation: c, access, question, questionsLeftToday: left, questionsLeftInChat: MAX_QUESTIONS_PER_CHAT - c.questionCount - 1 };
  }

  /**
   * Writes the answer, sending events as it goes. Never throws: a problem ends with an `error` event (or,
   * if the person left, silently). The chat is released at the end either way.
   */
  async answer(turn: Turn, emit: (event: ChatEvent) => void, signal: AbortSignal): Promise<void> {
    const id = turn.conversation.id;
    try {
      await this.run(turn, emit, signal);
    } catch (err) {
      if (err instanceof AiAbortedError || signal.aborted) {
        this.deps.logger?.info({ conversationId: id }, "an AI answer was stopped (the chat was closed)");
      } else if (err instanceof AiUnavailableError) {
        this.deps.logger?.warn({ err, status: err.status, conversationId: id }, "Claude didn't answer");
        emit({ type: "error", message: CANNED.unavailable });
      } else {
        this.deps.logger?.error({ err, conversationId: id }, "an AI answer failed");
        emit({ type: "error", message: CANNED.failed });
      }
    } finally {
      await this.deps.prisma.aiConversation
        .updateMany({ where: { id }, data: { busyUntil: null, lastMessageAt: this.now() } })
        .catch((err: unknown) => this.deps.logger?.error({ err, conversationId: id }, "releasing an AI chat failed"));
    }
  }

  private async run(turn: Turn, emit: (event: ChatEvent) => void, signal: AbortSignal): Promise<void> {
    const { prisma, limits, logger } = this.deps;
    const model = this.model();
    const c = turn.conversation;
    const scope = this.scope(c.scope);
    const ctx: ToolContext = turn.access.ctx;
    /** Tables this question's lookups produced, by id; the answer chooses which to show. */
    const tables = new Map<string, AnswerTable>();
    const userKey = hmacHex(this.deps.secret, `ai-user:${c.userId ?? c.visitorHash}`).slice(0, 40);

    const history = await prisma.aiMessage.findMany({ where: { conversationId: c.id }, orderBy: { seq: "asc" }, select: { role: true, content: true } });
    const messages: BetaMessageParam[] = history.map((m) => ({ role: m.role === "USER" ? "user" : "assistant", content: m.content as unknown as BetaContentBlockParam[] }));
    let seq = history.length;
    const save = (role: AiRole, content: BetaContentBlockParam[], extra: { text?: string; cards?: CardRefs; usage?: AiUsage; model?: string; stopReason?: string | null } = {}) =>
      prisma.aiMessage.create({
        data: {
          conversationId: c.id,
          seq: seq++,
          role,
          content: content as unknown as Prisma.InputJsonValue,
          text: extra.text ?? null,
          ...(extra.cards ? { cards: extra.cards as unknown as Prisma.InputJsonValue } : {}),
          model: extra.model ?? null,
          stopReason: extra.stopReason ?? null,
          inputTokens: extra.usage?.inputTokens ?? 0,
          outputTokens: extra.usage?.outputTokens ?? 0,
          cacheReadTokens: extra.usage?.cacheReadTokens ?? 0,
          cacheWriteTokens: extra.usage?.cacheWriteTokens ?? 0
        },
        select: { id: true }
      });

    // The question: "not run" results for lookups an interrupted answer left open, Vendora's context, then the question.
    const question: BetaContentBlockParam[] = [
      ...unansweredToolCalls(messages).map((toolUseId): BetaToolResultBlockParam => ({ type: "tool_result", tool_use_id: toolUseId, is_error: true, content: "Not run: that answer was interrupted." })),
      { type: "text", text: await this.context(c, turn.access, history.length === 0) },
      { type: "text", text: turn.question }
    ];
    await save("USER", question, { text: turn.question });
    messages.push({ role: "user", content: question });

    let shown = ""; // everything the person has seen of this answer
    for (let rounds = 0; ; ) {
      let firstDelta = true;
      const response = await model.stream(
        { system: scope.system, tools: scope.definitions, messages, userKey },
        {
          signal,
          onText: (delta) => {
            if (!delta) return;
            if (firstDelta && shown && !shown.endsWith("\n")) {
              shown += "\n\n";
              emit({ type: "text", delta: "\n\n" });
            }
            firstDelta = false;
            shown += delta;
            emit({ type: "text", delta });
          }
        }
      );
      await limits.recordSpend(response.usage.costMicroUsd).catch((err: unknown) => logger?.error({ err }, "recording AI spending failed"));
      if (response.droppedThinking > 0) logger?.warn({ conversationId: c.id, dropped: response.droppedThinking }, "Claude dropped earlier thinking: the instructions changed during this chat");
      const meta = { usage: response.usage, model: response.model, stopReason: response.stopReason };
      const calls = toolCalls(response.content);

      // Lookups: run them (with the chat owner's permissions), send the results back, and go round again.
      if (response.stopReason === "tool_use" && calls.length > 0 && rounds < MAX_LOOKUP_ROUNDS) {
        const content = echoable(response.content);
        await save("ASSISTANT", content, meta);
        messages.push({ role: "assistant", content });
        rounds++;
        const resultSeq = seq; // the results message's position names its tables ("t7-1")
        const results: BetaContentBlockParam[] = await Promise.all(
          calls.map((call, i) => this.runTool(scope, call, ctx, emit, (table) => {
            const tableId = `t${resultSeq}-${i + 1}`;
            tables.set(tableId, { id: tableId, ...table });
            return tableId;
          }))
        );
        if (rounds === MAX_LOOKUP_ROUNDS) results.push({ type: "text", text: LAST_ROUND_NOTE });
        await save("USER", results);
        messages.push({ role: "user", content: results });
        continue;
      }

      // The end of the answer.
      let content = echoable(response.content);
      let text = shown;
      if (response.stopReason === "end_turn" || response.stopReason === "stop_sequence") {
        if (!shown.trim()) text = this.replace(CANNED.empty, shown, emit);
      } else if (response.stopReason === "tool_use" && calls.length > 0) {
        // Still asking for lookups after the last round: stop. Its open calls get "not run" results next time.
        const note = CANNED.tooManyLookups;
        const sep = shown.trim() ? "\n\n" : "";
        emit({ type: "text", delta: sep + note });
        text = shown + sep + note;
      } else {
        // Declined by the safety checks (even after the fallback), cut off at the length limit, or anything
        // unexpected: the partial answer is discarded and replaced, in the chat and in the transcript.
        const note = response.stopReason === "refusal" ? scope.declined : CANNED.cutOff;
        text = this.replace(note, shown, emit);
        content = [{ type: "text", text: note }];
      }
      if (content.length === 0) content = [{ type: "text", text }];

      // Tables the answer marked, from this question's lookups, kept as they were (a snapshot of the answer's data).
      const shownTables = [...new Set([...text.matchAll(TABLE_MARKER)].map((m) => (m[1] ?? "").toLowerCase()))].flatMap((tid) => tables.get(tid) ?? []).slice(0, MAX_TABLES);
      const refs: CardRefs = { ...linkedRefs(text), ...(shownTables.length ? { tables: shownTables } : {}) };
      const saved = await save("ASSISTANT", content, { ...meta, text, cards: refs });
      const cards = await resolveCards(this.deps, refs, c.userId);
      if (cards.products.length || cards.orders.length || cards.tables.length) emit({ type: "cards", ...cards });
      emit({ type: "done", messageId: saved.id, suggestions: scope.suggestions(cards, c.userId !== null), questionsLeftToday: turn.questionsLeftToday, questionsLeftInChat: turn.questionsLeftInChat });
      return;
    }
  }

  /** Clears what was shown and shows `note` instead. */
  private replace(note: string, shown: string, emit: (event: ChatEvent) => void): string {
    if (shown) emit({ type: "discard" });
    emit({ type: "text", delta: note });
    return note;
  }

  /**
   * One lookup: an unknown tool or invalid arguments are reported back to Claude (it can correct itself), never
   * run. A result that can be a table is kept (`keepTable` names it) and Claude gets its data plus the table id.
   */
  private async runTool(
    scope: Scope,
    call: BetaToolUseBlock,
    ctx: ToolContext,
    emit: (event: ChatEvent) => void,
    keepTable: (table: Omit<AnswerTable, "id">) => string
  ): Promise<BetaToolResultBlockParam> {
    const result = (content: string, isError = false): BetaToolResultBlockParam => ({ type: "tool_result", tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
    const tool = scope.tools.get(call.name);
    if (!tool) return result(`There is no tool called ${call.name}.`, true);
    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) return result(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`, true);
    emit({ type: "status", text: tool.status });
    try {
      const out = await tool.run(parsed.data, ctx);
      if (out instanceof WithTable) return result(JSON.stringify(out.table.rows.length ? { ...out.data, table_id: keepTable(out.table) } : out.data));
      return result(JSON.stringify(out));
    } catch (err) {
      this.deps.logger?.error({ err, tool: call.name }, "an AI lookup failed");
      return result("The lookup failed. Answer without it, or suggest trying again later.", true);
    }
  }

  /** Vendora's trusted note at the start of each question: the time, who's asking (and for which store), and the product page it came from. */
  private async context(c: AiConversation, access: Access, first: boolean): Promise<string> {
    const lines = [`Now: ${NOW_FORMAT.format(this.now())} (Philippine time).`, ...access.context];
    if (first && c.productId) {
      const p = await this.deps.prisma.product.findUnique({ where: { id: c.productId }, select: { id: true } });
      if (p) lines.push(`They opened this chat from a product page: product id ${p.id} (url /products/${p.id}). Use get_product to see it.`);
    }
    return `<context>\n${lines.join("\n")}\n</context>`;
  }
}

/** Follow-up chips under a shopper answer. */
function shopperSuggestions(cards: Cards, signedIn: boolean): string[] {
  const list: string[] = [];
  if (cards.products.length >= 2) list.push("Compare these");
  else if (cards.products.length === 1) list.push("What do reviews say?");
  if (cards.orders.length) list.push("When will it arrive?");
  list.push(signedIn ? "What's in my cart?" : "How much is delivery?");
  list.push("Which payment methods can I use?");
  return list.slice(0, 3);
}
