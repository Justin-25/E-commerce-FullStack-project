import type { DocumentType, Prisma, PrismaClient, StoreStatus } from "../../generated/prisma/client.js";
import { BackgroundMailer } from "../../lib/backgroundMailer.js";
import type { EmailSender } from "../../lib/email.js";
import { createFieldCipher, type FieldCipher } from "../../lib/encryption.js";
import { AppError } from "../../lib/errors.js";
import type { KeyValueStore } from "../../lib/kv.js";
import type { Logger } from "../../lib/logger.js";
import type { MediaStorage, UploadTicket } from "../../lib/media.js";
import { isUniqueViolation } from "../../lib/prismaErrors.js";
import { recordSecurityEvent, type ClientInfo } from "../auth/events.js";
import { payoutAccountChangedEmail, storeSubmittedEmail } from "./seller.emails.js";
import {
  MAX_DOCUMENTS,
  RESERVED_STORE_SLUGS,
  storeSlug,
  type DocumentInput,
  type PayoutAccountInput,
  type StoreDetailsInput,
  type UploadPurpose,
  type VerificationInput
} from "./seller.schemas.js";
import { SellerUploads } from "./uploads.js";

type Tx = Prisma.TransactionClient;

/** What's still needed before "Submit for review" (in the order of the steps). */
export type MissingItem = "two_factor" | "store_details" | "verification" | "gov_id" | "business_certificate" | "payout_account";

export interface OnboardingView {
  /** Required before anything else (sellers must use two-step verification). */
  twoFactorEnabled: boolean;
  store: {
    id: string;
    name: string;
    slug: string;
    status: StoreStatus;
    category: { slug: string; name: string } | null;
    description: string | null;
    shipsFrom: string | null;
    logoUrl: string | null;
    submittedAt: string | null;
    approvedAt: string | null;
    verification: {
      businessType: "INDIVIDUAL" | "REGISTERED_BUSINESS";
      legalName: string | null;
      registrationNo: string | null;
      /** "TIN ending in 000": the full number is never sent back. */
      tinLast3: string | null;
    };
    documents: { id: string; type: DocumentType; format: string | null; bytes: number | null; status: string; createdAt: string }[];
    payoutAccount: { method: "GCASH" | "BANK"; bankName: string | null; accountName: string; last4: string; verifiedAt: string | null } | null;
    /** The admin's answer when changes were requested (edit, then "Submit again") or the application was rejected (final). */
    review: { status: "CHANGES_REQUESTED" | "REJECTED"; note: string; reviewedAt: string | null } | null;
    /** Suspended (7c-2): since when, and Support's reason (the seller can look but not change anything; paid orders still ship). */
    suspension: { at: string | null; reason: string | null; until: string | null } | null;
  } | null;
  steps: { storeDetails: boolean; verification: boolean; payoutAccount: boolean };
  missing: MissingItem[];
  canSubmit: boolean;
  /** Set after submitting: refresh the session (POST /auth/refresh) to get the seller role in the access pass. */
  refreshSession?: true;
}

const forbidden = (reason: string, message: string) => new AppError(403, "FORBIDDEN", message, { details: { reason } });
const conflict = (reason: string, message: string, field?: string) =>
  new AppError(409, "CONFLICT", message, { details: { reason }, ...(field ? { fields: [{ path: field, message }] } : {}) });
const badField = (path: string, message: string) => new AppError(400, "VALIDATION_ERROR", "Some fields are invalid", { fields: [{ path, message }] });
const noStore = () => new AppError(404, "NOT_FOUND", "Set up your store details first.");
/** Legal details and documents can't change once submitted, unless an admin asks for changes (milestone 7a). */
const EDITABLE_LEGAL: StoreStatus[] = ["DRAFT", "CHANGES_REQUESTED"];
const tinContext = (storeId: string) => `store:${storeId}:tin`;
const payoutContext = (storeId: string) => `store:${storeId}:payout`;

/**
 * Becoming a seller (Seller Center onboarding): store details → business verification →
 * payout account → "Submit for review". Everything is saved as a draft as it goes ("Save
 * and exit"). Submitting makes the store PENDING and the account a SELLER; an admin approves
 * it in milestone 7, and only then does it appear to shoppers.
 */
export class OnboardingService {
  private readonly cipher: FieldCipher;
  private readonly mailer: BackgroundMailer;
  private readonly uploads: SellerUploads;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      kv: KeyValueStore;
      /** null = uploads off (no CLOUDINARY_URL). */
      media: MediaStorage | null;
      email: EmailSender;
      config: { DATA_ENCRYPTION_KEY: string; APP_URL: string };
      logger?: Logger;
      now?: () => Date;
    }
  ) {
    this.cipher = createFieldCipher(deps.config.DATA_ENCRYPTION_KEY);
    this.mailer = new BackgroundMailer(deps.email, deps.logger);
    this.uploads = new SellerUploads({ kv: deps.kv, media: deps.media, ...(deps.logger ? { logger: deps.logger } : {}) });
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async drain(): Promise<void> {
    await this.mailer.drain();
  }

  // --- reading ------------------------------------------------------------------

  async view(userId: string): Promise<OnboardingView> {
    const { prisma } = this.deps;
    const [user, store] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorEnabledAt: true } }),
      prisma.store.findUnique({
        where: { ownerId: userId },
        include: { category: { select: { slug: true, name: true } }, documents: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] }, payoutAccount: true }
      })
    ]);
    const twoFactorEnabled = user.twoFactorEnabledAt !== null;
    if (!store) {
      const missing: MissingItem[] = [...(twoFactorEnabled ? [] : ["two_factor" as const]), "store_details", "verification", "gov_id", "payout_account"];
      return { twoFactorEnabled, store: null, steps: { storeDetails: false, verification: false, payoutAccount: false }, missing, canSubmit: false };
    }

    const types = new Set(store.documents.map((d) => d.type));
    const business = store.businessType === "REGISTERED_BUSINESS";
    const details = Boolean(store.categoryId && store.shipsFrom);
    const legal = Boolean(store.legalName && store.tinEncrypted && (!business || store.registrationNo));
    const missing: MissingItem[] = [];
    if (!twoFactorEnabled) missing.push("two_factor");
    if (!details) missing.push("store_details");
    if (!legal) missing.push("verification");
    if (!types.has("GOV_ID")) missing.push("gov_id");
    if (business && !types.has("DTI_CERT") && !types.has("SEC_CERT")) missing.push("business_certificate");
    if (!store.payoutAccount) missing.push("payout_account");

    return {
      twoFactorEnabled,
      store: {
        id: store.id,
        name: store.name,
        slug: store.slug,
        status: store.status,
        category: store.category,
        description: store.description,
        shipsFrom: store.shipsFrom,
        logoUrl: store.logoUrl,
        submittedAt: store.submittedAt?.toISOString() ?? null,
        approvedAt: store.approvedAt?.toISOString() ?? null,
        verification: {
          businessType: store.businessType,
          legalName: store.legalName,
          registrationNo: store.registrationNo,
          tinLast3: store.tinEncrypted ? this.cipher.decrypt(store.tinEncrypted, tinContext(store.id)).slice(-3) : null
        },
        documents: store.documents.map((d) => ({ id: d.id, type: d.type, format: d.format, bytes: d.bytes, status: d.status, createdAt: d.createdAt.toISOString() })),
        payoutAccount: store.payoutAccount
          ? {
              method: store.payoutAccount.method,
              bankName: store.payoutAccount.bankName,
              accountName: store.payoutAccount.accountName,
              last4: store.payoutAccount.last4,
              verifiedAt: store.payoutAccount.verifiedAt?.toISOString() ?? null
            }
          : null,
        review:
          (store.status === "CHANGES_REQUESTED" || store.status === "REJECTED") && store.reviewNote
            ? { status: store.status, note: store.reviewNote, reviewedAt: store.reviewedAt?.toISOString() ?? null }
            : null,
        suspension:
          store.status === "SUSPENDED"
            ? { at: store.suspendedAt?.toISOString() ?? null, reason: store.suspendedReason, until: store.suspendedUntil?.toISOString() ?? null }
            : null
      },
      steps: { storeDetails: details, verification: legal && !missing.includes("gov_id") && !missing.includes("business_certificate"), payoutAccount: Boolean(store.payoutAccount) },
      missing,
      canSubmit: missing.length === 0 && EDITABLE_LEGAL.includes(store.status)
    };
  }

  // --- step 1: store details ------------------------------------------------------

  /** Creates the draft store on first save. The name (and so the web address) is unique and locked once submitted. */
  async saveDetails(userId: string, input: StoreDetailsInput): Promise<OnboardingView> {
    const { prisma } = this.deps;
    await this.canEdit(userId);
    const slug = storeSlug(input.name);
    if (RESERVED_STORE_SLUGS.includes(slug) || slug.includes("vendora")) throw conflict("name_reserved", "This name is reserved. Please choose another.", "name");
    const category = await prisma.category.findFirst({ where: { slug: input.category, parentId: null }, select: { id: true } });
    if (!category) throw badField("category", "Choose what your store sells");

    try {
      await prisma.$transaction(async (tx) => {
        await lockUser(tx, userId); // one onboarding change at a time per account
        const taken = await tx.store.findUnique({ where: { slug }, select: { ownerId: true } });
        if (taken && taken.ownerId !== userId) throw nameTaken();
        // A renamed store's old address stays reserved forever (it redirects to that store, 7c-2).
        const old = await tx.storeSlugRedirect.findUnique({ where: { slug }, select: { store: { select: { ownerId: true } } } });
        if (old && old.store.ownerId !== userId) throw nameTaken();
        const existing = await tx.store.findUnique({ where: { ownerId: userId }, select: { id: true, name: true, status: true } });
        const data = { categoryId: category.id, description: input.description, shipsFrom: input.shipsFrom };
        if (!existing) {
          await tx.store.create({ data: { ...data, ownerId: userId, name: input.name, slug, status: "DRAFT", businessType: "INDIVIDUAL" } });
          return;
        }
        if (existing.name !== input.name && existing.status !== "DRAFT") {
          throw conflict("name_locked", "Your store name can't be changed after submitting. Contact Vendora support to rename it.", "name");
        }
        await tx.store.update({ where: { id: existing.id }, data: { ...data, name: input.name, slug } });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken(); // another seller took the name at the same moment
      throw err;
    }
    return this.view(userId);
  }

  /** The store logo: a public image the browser uploaded with a ticket. A replaced logo is deleted from storage. */
  async setLogo(userId: string, publicId: string): Promise<OnboardingView> {
    await this.canEdit(userId);
    const store = await this.storeOf(userId);
    const media = await this.uploads.check(userId, "store_logo", publicId);
    await this.deps.prisma.store.update({ where: { id: store.id }, data: { logoUrl: media.url, logoPublicId: media.publicId } });
    if (store.logoPublicId && store.logoPublicId !== media.publicId) await this.uploads.discard(store.logoPublicId, "public");
    return this.view(userId);
  }

  async removeLogo(userId: string): Promise<OnboardingView> {
    await this.canEdit(userId);
    const store = await this.storeOf(userId);
    await this.deps.prisma.store.update({ where: { id: store.id }, data: { logoUrl: null, logoPublicId: null } });
    if (store.logoPublicId) await this.uploads.discard(store.logoPublicId, "public");
    return this.view(userId);
  }

  // --- step 2: business verification --------------------------------------------

  async saveVerification(userId: string, input: VerificationInput): Promise<OnboardingView> {
    await this.canEdit(userId);
    const store = await this.storeOf(userId);
    if (!EDITABLE_LEGAL.includes(store.status)) throw submitted();
    await this.deps.prisma.store.update({
      where: { id: store.id },
      data: {
        businessType: input.businessType,
        legalName: input.legalName,
        registrationNo: input.registrationNo,
        tinEncrypted: this.cipher.encrypt(input.tin, tinContext(store.id))
      }
    });
    return this.view(userId);
  }

  /** A verification document (private file). Its type and size are read from storage, never from the browser. */
  async addDocument(userId: string, input: DocumentInput): Promise<OnboardingView> {
    const { prisma } = this.deps;
    await this.canEdit(userId);
    const store = await this.storeOf(userId);
    if (!EDITABLE_LEGAL.includes(store.status)) throw submitted();
    const media = await this.uploads.check(userId, "store_document", input.publicId);
    await prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      if ((await tx.storeDocument.count({ where: { storeId: store.id } })) >= MAX_DOCUMENTS) throw conflict("too_many_documents", `You can upload up to ${MAX_DOCUMENTS} documents. Remove one first.`);
      if (await tx.storeDocument.findFirst({ where: { fileKey: media.publicId }, select: { id: true } })) throw conflict("already_added", "This file was already added.");
      await tx.storeDocument.create({ data: { storeId: store.id, type: input.type, fileKey: media.publicId, format: media.format, bytes: media.bytes } });
    });
    return this.view(userId);
  }

  async removeDocument(userId: string, documentId: string): Promise<OnboardingView> {
    const { prisma } = this.deps;
    await this.canEdit(userId);
    const store = await this.storeOf(userId);
    if (!EDITABLE_LEGAL.includes(store.status)) throw submitted();
    const doc = await prisma.storeDocument.findFirst({ where: { id: documentId, storeId: store.id } });
    if (!doc) throw new AppError(404, "NOT_FOUND", "This document doesn't exist.");
    await prisma.storeDocument.delete({ where: { id: doc.id } });
    // The private file goes too (best effort: a leftover file is private and unreferenced).
    await this.uploads.discard(doc.fileKey, "private");
    return this.view(userId);
  }

  // --- step 3: payout account ---------------------------------------------------

  /**
   * Where payouts go. The number is stored encrypted; only the last 4 digits are shown. Once
   * the store is submitted, CHANGING it needs "Confirm it's you" and the owner gets an email
   * (so a stolen session can't quietly redirect the money).
   */
  async setPayoutAccount(userId: string, input: PayoutAccountInput, ctx: { ensureConfirmed: () => Promise<void>; client: ClientInfo }): Promise<OnboardingView> {
    const { prisma } = this.deps;
    await this.canEdit(userId);
    const store = await this.storeOf(userId);
    const existing = await prisma.payoutAccount.findUnique({ where: { storeId: store.id }, select: { id: true } });
    const isChange = existing !== null && store.status !== "DRAFT";
    if (isChange) await ctx.ensureConfirmed();

    const data = {
      method: input.method,
      bankName: input.method === "BANK" ? input.bankName : null,
      accountName: input.accountName,
      accountNumberEncrypted: this.cipher.encrypt(input.accountNumber, payoutContext(store.id)),
      last4: input.accountNumber.slice(-4),
      verifiedAt: null // a new account is checked again (milestone 7)
    };
    await prisma.$transaction(async (tx) => {
      await tx.payoutAccount.upsert({ where: { storeId: store.id }, create: { ...data, storeId: store.id }, update: data });
      if (isChange) await recordSecurityEvent(tx, userId, "PAYOUT_ACCOUNT_CHANGED", ctx.client);
    });
    if (isChange) {
      const owner = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
      const summary = input.method === "GCASH" ? `GCash •••• ${data.last4}` : `${input.bankName} •••• ${data.last4}`;
      this.mailer.send(payoutAccountChangedEmail(owner.email, store.name, summary, this.deps.config.APP_URL));
    }
    return this.view(userId);
  }

  // --- submit -------------------------------------------------------------------

  /**
   * "Submit for review": the store becomes PENDING and the account a SELLER (so Seller Center
   * opens; products can be added while we review). Sending it twice is harmless.
   */
  async submit(userId: string): Promise<OnboardingView> {
    const { prisma } = this.deps;
    await this.canEdit(userId);
    const before = await this.view(userId);
    if (!before.store) throw noStore();
    if (before.store.status === "PENDING" || before.store.status === "APPROVED") return { ...before, refreshSession: true };
    if (before.store.status === "SUSPENDED") throw forbidden("store_suspended", "This store is suspended. Contact Vendora support.");
    if (before.missing.length > 0) {
      throw new AppError(409, "CONFLICT", "Some steps aren't finished yet.", { details: { reason: "incomplete", missing: before.missing.join(",") } });
    }
    const storeName = before.store.name;
    const email = await prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const moved = await tx.store.updateMany({ where: { ownerId: userId, status: { in: EDITABLE_LEGAL } }, data: { status: "PENDING", submittedAt: this.now() } });
      const user = await tx.user.update({ where: { id: userId }, data: { role: "SELLER" }, select: { email: true } });
      return moved.count === 1 ? user.email : null; // null: a simultaneous submit already did it
    });
    if (email) this.mailer.send(storeSubmittedEmail(email, storeName, this.deps.config.APP_URL));
    return { ...(await this.view(userId)), refreshSession: true };
  }

  // --- uploads ------------------------------------------------------------------

  /** A one-time permission for the browser to upload one logo or document (at most 30 an hour per account). */
  async uploadTicket(userId: string, purpose: Exclude<UploadPurpose, "product_photo">): Promise<UploadTicket> {
    await this.canEdit(userId);
    return this.uploads.ticket(userId, purpose);
  }

  // --- rules --------------------------------------------------------------------

  /** Who can set up a store: signed-in non-admins with two-step verification on (agreed in milestone 3). */
  private async canEdit(userId: string): Promise<void> {
    const user = await this.deps.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true, twoFactorEnabledAt: true } });
    if (user.role === "ADMIN") throw forbidden("admin_account", "Admin accounts can't open a store.");
    if (!user.twoFactorEnabledAt) throw forbidden("two_factor_required", "Turn on two-step verification before opening a store.");
    const store = await this.deps.prisma.store.findUnique({ where: { ownerId: userId }, select: { status: true } });
    if (store?.status === "SUSPENDED") throw forbidden("store_suspended", "This store is suspended. Contact Vendora support.");
    if (store?.status === "REJECTED") throw forbidden("store_rejected", "This application was rejected. Contact Vendora support if you think it's a mistake.");
  }

  private async storeOf(userId: string) {
    const store = await this.deps.prisma.store.findUnique({ where: { ownerId: userId }, select: { id: true, name: true, status: true, logoPublicId: true } });
    if (!store) throw noStore();
    return store;
  }
}

const nameTaken = () => conflict("name_taken", "This store name is taken. Please choose another.", "name");
const submitted = () => conflict("store_submitted", "Your business details can't be changed after submitting. Contact Vendora support if something is wrong.");

async function lockUser(tx: Tx, userId: string) {
  await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
}
