import type { Prisma, PrismaClient, StoreStatus } from "../../generated/prisma/client.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import type { EmailSender } from "../../lib/email.js";
import { createFieldCipher, type FieldCipher } from "../../lib/encryption.js";
import { AppError } from "../../lib/errors.js";
import { likeLiteral } from "../../lib/like.js";
import type { Logger } from "../../lib/logger.js";
import type { MediaStorage } from "../../lib/media.js";
import { approveStore } from "../seller/approval.js";
import { payoutAccountVerifiedEmail, storeApprovedEmail, storeChangesRequestedEmail, storeRejectedEmail } from "../seller/seller.emails.js";
import { adminUser } from "./access.js";
import { ADMIN_PAGE_SIZE, DOCUMENT_LINK_SECONDS, type ApplicationListQuery, type ApplicationTab } from "./admin.schemas.js";
import { audit } from "./audit.js";

const TAB_STATUS: Record<ApplicationTab, StoreStatus> = { pending: "PENDING", changes_requested: "CHANGES_REQUESTED", rejected: "REJECTED", approved: "APPROVED" };
const notFound = () => new AppError(404, "NOT_FOUND", "This store doesn't exist.");
const notPending = () => new AppError(409, "CONFLICT", "This application isn't waiting for review any more. Reload to see where it is.", { details: { reason: "not_pending" } });
const tinContext = (storeId: string) => `store:${storeId}:tin`;
const payoutContext = (storeId: string) => `store:${storeId}:payout`;
/** Stored as digits; shown as on BIR forms: "123456789000" → "123-456-789-000" (9 digits + a 3- or 5-digit branch code). */
const formatTin = (digits: string) => [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9), digits.slice(9)].filter(Boolean).join("-");
/** "123-456-789-000" → "•••-•••-•••-000": only the last 3 digits show. */
const maskTin = (digits: string) => formatTin(digits).replace(/\d(?=.*\d{3}$)/g, "•");

export interface Check {
  key: "store_details" | "business_details" | "gov_id" | "business_certificate" | "payout_account";
  label: string;
  passed: boolean;
}

type StoreForChecks = {
  categoryId: string | null;
  shipsFrom: string | null;
  businessType: "INDIVIDUAL" | "REGISTERED_BUSINESS";
  legalName: string | null;
  registrationNo: string | null;
  tinEncrypted: string | null;
  documents: { type: string }[];
  payoutAccount: unknown;
};

/** What a reviewer checks first: everything the application needs is there (the documents themselves are read by a person). */
function checksFor(s: StoreForChecks): Check[] {
  const business = s.businessType === "REGISTERED_BUSINESS";
  const types = new Set(s.documents.map((d) => d.type));
  return [
    { key: "store_details" as const, label: "Store details", passed: Boolean(s.categoryId && s.shipsFrom) },
    { key: "business_details" as const, label: business ? "Business name, DTI/SEC number and TIN" : "Legal name and TIN", passed: Boolean(s.legalName && s.tinEncrypted && (!business || s.registrationNo)) },
    { key: "gov_id" as const, label: "Government ID", passed: types.has("GOV_ID") },
    ...(business ? [{ key: "business_certificate" as const, label: "DTI or SEC certificate", passed: types.has("DTI_CERT") || types.has("SEC_CERT") }] : []),
    { key: "payout_account" as const, label: "Payout account", passed: Boolean(s.payoutAccount) }
  ];
}

/**
 * Admin → Seller approvals and payout-account checks (milestone 7a, Support role).
 *
 * Reviewing an application: the details, the full TIN (only on request, and each look is in the
 * audit log), the ID and DTI/SEC documents through 5-minute private links (also logged), and the
 * payout account. Then Approve (it goes live; "Confirm it's you" first, since it also verifies
 * where the money goes), Ask for changes (back to the seller with a note; they can edit and submit
 * again) or Reject (final). Each decision is one transaction with its audit row, then an email.
 */
export class ApplicationService {
  private readonly cipher: FieldCipher;
  private readonly mailer: BackgroundMailer;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      /** null = uploads off (no CLOUDINARY_URL): documents can't be opened. */
      media: MediaStorage | null;
      email: EmailSender;
      config: { DATA_ENCRYPTION_KEY: string; APP_URL: string };
      logger?: Logger;
      now?: () => Date;
    }
  ) {
    this.cipher = createFieldCipher(deps.config.DATA_ENCRYPTION_KEY);
    this.mailer = new BackgroundMailer(deps.email, deps.logger);
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async drain(): Promise<void> {
    await this.mailer.drain();
  }

  // --- the queue ------------------------------------------------------------------

  /** Waiting applications oldest first (first come, first reviewed); the other tabs newest first. */
  async list(adminId: string, query: ApplicationListQuery) {
    const { prisma } = this.deps;
    await adminUser(prisma, adminId, "SUPPORT");
    const search: Prisma.StoreWhereInput = query.q
      ? { OR: [{ name: { contains: likeLiteral(query.q), mode: "insensitive" } }, { slug: { contains: likeLiteral(query.q.toLowerCase()) } }, { owner: { email: { contains: likeLiteral(query.q.toLowerCase()) } } }] }
      : {};
    const where: Prisma.StoreWhereInput = { AND: [{ status: TAB_STATUS[query.tab] }, search] };
    const count = (tab: ApplicationTab) => prisma.store.count({ where: { status: TAB_STATUS[tab] } });
    const [rows, totalItems, pending, changesRequested, rejected, approved] = await Promise.all([
      prisma.store.findMany({
        where,
        orderBy: query.tab === "pending" ? [{ submittedAt: "asc" }, { id: "asc" }] : [{ reviewedAt: "desc" }, { submittedAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * ADMIN_PAGE_SIZE,
        take: ADMIN_PAGE_SIZE,
        include: { category: { select: { name: true } }, documents: { select: { type: true } }, payoutAccount: { select: { id: true } }, owner: { select: { name: true, email: true } } }
      }),
      prisma.store.count({ where }),
      count("pending"),
      count("changes_requested"),
      count("rejected"),
      count("approved")
    ]);
    return {
      items: rows.map((s) => {
        const checks = checksFor(s);
        return {
          storeId: s.id,
          name: s.name,
          slug: s.slug,
          logoUrl: s.logoUrl,
          businessType: s.businessType,
          category: s.category?.name ?? null,
          shipsFrom: s.shipsFrom,
          owner: { name: s.owner.name, email: s.owner.email },
          status: s.status,
          submittedAt: s.submittedAt?.toISOString() ?? null,
          reviewedAt: s.reviewedAt?.toISOString() ?? null,
          checks: { passed: checks.filter((c) => c.passed).length, total: checks.length }
        };
      }),
      counts: { pending, changesRequested, rejected, approved },
      page: query.page,
      pageSize: ADMIN_PAGE_SIZE,
      totalItems,
      totalPages: Math.ceil(totalItems / ADMIN_PAGE_SIZE)
    };
  }

  // --- one application ------------------------------------------------------------------

  async view(adminId: string, storeId: string) {
    await adminUser(this.deps.prisma, adminId, "SUPPORT");
    return this.load(storeId);
  }

  private async load(storeId: string) {
    const { prisma } = this.deps;
    const s = await prisma.store.findUnique({
      where: { id: storeId },
      include: {
        category: { select: { slug: true, name: true } },
        documents: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
        payoutAccount: true,
        owner: { select: { id: true, name: true, email: true, emailVerifiedAt: true, twoFactorEnabledAt: true, createdAt: true } },
        reviewedBy: { select: { name: true } }
      }
    });
    if (!s || s.status === "DRAFT") throw notFound();
    const history = await prisma.auditLog.findMany({
      where: { targetType: "store", targetId: s.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      include: { actor: { select: { name: true } } }
    });
    const checks = checksFor(s);
    return {
      storeId: s.id,
      name: s.name,
      slug: s.slug,
      status: s.status,
      logoUrl: s.logoUrl,
      description: s.description,
      category: s.category,
      shipsFrom: s.shipsFrom,
      submittedAt: s.submittedAt?.toISOString() ?? null,
      approvedAt: s.approvedAt?.toISOString() ?? null,
      owner: { id: s.owner.id, name: s.owner.name, email: s.owner.email, emailVerified: s.owner.emailVerifiedAt !== null, twoFactor: s.owner.twoFactorEnabledAt !== null, joinedAt: s.owner.createdAt.toISOString() },
      business: {
        type: s.businessType,
        legalName: s.legalName,
        registrationNo: s.registrationNo,
        /** "•••-•••-•••-000": the full number only through POST …/tin (logged). */
        tinMasked: s.tinEncrypted ? maskTin(this.cipher.decrypt(s.tinEncrypted, tinContext(s.id))) : null
      },
      documents: s.documents.map((d) => ({ id: d.id, type: d.type, format: d.format, bytes: d.bytes, status: d.status, uploadedAt: d.createdAt.toISOString() })),
      payoutAccount: s.payoutAccount
        ? { method: s.payoutAccount.method, bankName: s.payoutAccount.bankName, accountName: s.payoutAccount.accountName, last4: s.payoutAccount.last4, verified: s.payoutAccount.verifiedAt !== null }
        : null,
      checks,
      review: s.reviewedAt ? { by: s.reviewedBy?.name ?? null, at: s.reviewedAt.toISOString(), note: s.reviewNote } : null,
      canReview: s.status === "PENDING",
      history: history.map((h) => ({ action: h.action, by: h.actor?.name ?? "A command on the server", at: h.createdAt.toISOString(), metadata: h.metadata }))
    };
  }

  /** "Show TIN": the full number, for checking against the documents. Each look is logged. */
  async revealTin(adminId: string, storeId: string, ip: string | null): Promise<{ tin: string }> {
    const { prisma } = this.deps;
    const admin = await adminUser(prisma, adminId, "SUPPORT");
    const s = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, status: true, tinEncrypted: true } });
    if (!s || s.status === "DRAFT") throw notFound();
    if (!s.tinEncrypted) throw new AppError(404, "NOT_FOUND", "This store hasn't entered a TIN.");
    const tin = formatTin(this.cipher.decrypt(s.tinEncrypted, tinContext(s.id)));
    await audit(prisma, { actorId: admin.id, action: "store.view_tin", targetType: "store", targetId: s.id, ip });
    return { tin };
  }

  /** "Open" a private ID or business document: a link that works for 5 minutes. Each opening is logged. */
  async documentLink(adminId: string, storeId: string, documentId: string, ip: string | null): Promise<{ url: string; expiresAt: string }> {
    const { prisma, media } = this.deps;
    const admin = await adminUser(prisma, adminId, "SUPPORT");
    const doc = await prisma.storeDocument.findFirst({ where: { id: documentId, storeId }, select: { id: true, type: true, fileKey: true, format: true } });
    if (!doc) throw new AppError(404, "NOT_FOUND", "This document doesn't exist.");
    if (!media) throw new AppError(503, "SERVICE_UNAVAILABLE", "File storage isn't set up, so documents can't be opened right now.");
    const url = media.downloadUrl(doc.fileKey, "private", doc.format ?? "pdf", DOCUMENT_LINK_SECONDS);
    await audit(prisma, { actorId: admin.id, action: "store.view_document", targetType: "store", targetId: storeId, metadata: { documentId: doc.id, type: doc.type }, ip });
    return { url, expiresAt: new Date(this.now().getTime() + DOCUMENT_LINK_SECONDS * 1000).toISOString() };
  }

  // --- decisions ----------------------------------------------------------------------

  /** "Approve seller": live for shoppers, documents checked, payout account verified (so "Confirm it's you" first). */
  async approve(adminId: string, storeId: string, input: { note: string | null }, ctx: { ensureConfirmed: () => Promise<void>; ip: string | null }) {
    const { prisma } = this.deps;
    const admin = await adminUser(prisma, adminId, "SUPPORT");
    const s = await prisma.store.findUnique({ where: { id: storeId }, select: { slug: true, name: true, status: true, owner: { select: { email: true } } } });
    if (!s || s.status === "DRAFT") throw notFound();
    if (s.status !== "PENDING") throw notPending();
    await ctx.ensureConfirmed();
    const result = await approveStore(prisma, s.slug, admin.id, this.now(), { note: input.note, ip: ctx.ip });
    if (result === "owner_suspended") {
      throw new AppError(409, "CONFLICT", "The owner's account is suspended, so the store can't go live. Reactivate the account first.", { details: { reason: "owner_suspended" } });
    }
    if (result !== "approved") throw notPending();
    this.mailer.send(storeApprovedEmail(s.owner.email, s.name, this.deps.config.APP_URL, input.note));
    return this.load(storeId);
  }

  /** "Ask for changes": back to the seller with the note; they can edit and submit again. */
  async requestChanges(adminId: string, storeId: string, note: string, ip: string | null) {
    return this.decide(adminId, storeId, "CHANGES_REQUESTED", note, ip);
  }

  /** "Reject": final (a fake or duplicate seller, a business we can't accept). */
  async reject(adminId: string, storeId: string, note: string, ip: string | null) {
    return this.decide(adminId, storeId, "REJECTED", note, ip);
  }

  private async decide(adminId: string, storeId: string, status: "CHANGES_REQUESTED" | "REJECTED", note: string, ip: string | null) {
    const { prisma } = this.deps;
    const admin = await adminUser(prisma, adminId, "SUPPORT");
    const now = this.now();
    const s = await prisma.$transaction(async (tx) => {
      const store = await tx.store.findUnique({ where: { id: storeId }, select: { id: true, name: true, status: true, owner: { select: { email: true } } } });
      if (!store || store.status === "DRAFT") throw notFound();
      // Only from "waiting for review", checked in the same statement (two admins at once: one decides).
      const moved = await tx.store.updateMany({ where: { id: storeId, status: "PENDING" }, data: { status, reviewNote: note, reviewedAt: now, reviewedById: admin.id } });
      if (moved.count !== 1) throw notPending();
      await audit(tx, { actorId: admin.id, action: status === "REJECTED" ? "store.reject" : "store.request_changes", targetType: "store", targetId: storeId, metadata: { note }, ip });
      return store;
    });
    const url = this.deps.config.APP_URL;
    this.mailer.send(status === "REJECTED" ? storeRejectedEmail(s.owner.email, s.name, note) : storeChangesRequestedEmail(s.owner.email, s.name, note, url));
    return this.load(storeId);
  }

  // --- payout accounts changed after approval ------------------------------------------

  /** Accounts waiting to be checked: changed by sellers whose stores were already approved (payouts wait until then). */
  async payoutAccounts(adminId: string) {
    const { prisma } = this.deps;
    await adminUser(prisma, adminId, "SUPPORT");
    const accounts = await prisma.payoutAccount.findMany({
      where: { verifiedAt: null, store: { status: { in: ["APPROVED", "SUSPENDED"] } } },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      include: { store: { select: { id: true, name: true, slug: true, owner: { select: { name: true, email: true } } } } }
    });
    return {
      items: accounts.map((a) => ({
        storeId: a.store.id,
        store: { name: a.store.name, slug: a.store.slug },
        owner: a.store.owner,
        method: a.method,
        bankName: a.bankName,
        accountName: a.accountName,
        last4: a.last4,
        changedAt: a.updatedAt.toISOString()
      }))
    };
  }

  /** "Show number": the full account number, for checking it. Each look is logged. */
  async revealPayoutNumber(adminId: string, storeId: string, ip: string | null): Promise<{ accountNumber: string }> {
    const { prisma } = this.deps;
    const admin = await adminUser(prisma, adminId, "SUPPORT");
    const account = await prisma.payoutAccount.findUnique({ where: { storeId }, select: { id: true, accountNumberEncrypted: true } });
    if (!account) throw new AppError(404, "NOT_FOUND", "This store has no payout account.");
    const accountNumber = this.cipher.decrypt(account.accountNumberEncrypted, payoutContext(storeId));
    await audit(prisma, { actorId: admin.id, action: "payout_account.view_number", targetType: "payout_account", targetId: account.id, metadata: { storeId }, ip });
    return { accountNumber };
  }

  /** "Verify": payouts go to this account from now on ("Confirm it's you" first: it decides where money goes). */
  async verifyPayoutAccount(adminId: string, storeId: string, ctx: { ensureConfirmed: () => Promise<void>; ip: string | null }) {
    const { prisma } = this.deps;
    const admin = await adminUser(prisma, adminId, "SUPPORT");
    const account = await prisma.payoutAccount.findUnique({ where: { storeId }, include: { store: { select: { name: true, owner: { select: { email: true } } } } } });
    if (!account) throw new AppError(404, "NOT_FOUND", "This store has no payout account.");
    if (account.verifiedAt) throw new AppError(409, "CONFLICT", "This payout account is already verified.", { details: { reason: "already_verified" } });
    await ctx.ensureConfirmed();
    const done = await prisma.$transaction(async (tx) => {
      // Only the account that was checked: if the seller changed it again meanwhile (new number), it stays unverified.
      const won = await tx.payoutAccount.updateMany({ where: { id: account.id, verifiedAt: null, accountNumberEncrypted: account.accountNumberEncrypted }, data: { verifiedAt: this.now() } });
      if (won.count !== 1) return false;
      await audit(tx, { actorId: admin.id, action: "payout_account.verify", targetType: "payout_account", targetId: account.id, metadata: { storeId, last4: account.last4 }, ip: ctx.ip });
      return true;
    });
    if (!done) throw new AppError(409, "CONFLICT", "This payout account changed meanwhile. Reload and check it again.", { details: { reason: "changed" } });
    const summary = account.method === "GCASH" ? `GCash •••• ${account.last4}` : `${account.bankName ?? "Bank"} •••• ${account.last4}`;
    this.mailer.send(payoutAccountVerifiedEmail(account.store.owner.email, account.store.name, summary, this.deps.config.APP_URL));
    return this.payoutAccounts(adminId);
  }
}
