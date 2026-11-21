import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { MAX_ADDRESSES, type AddressInput } from "./addresses.schemas.js";

const SELECT = {
  id: true,
  label: true,
  fullName: true,
  phone: true,
  region: true,
  province: true,
  city: true,
  barangay: true,
  street: true,
  postalCode: true,
  isDefault: true,
  createdAt: true
} as const;

export type Address = Prisma.AddressGetPayload<{ select: typeof SELECT }>;

/** Someone else's address id answers exactly like one that doesn't exist. */
const notFound = () => new AppError(404, "NOT_FOUND", "This address doesn't exist.");

/**
 * Saved delivery addresses. Every query is scoped to the signed-in user, and each
 * change runs in a transaction that first locks that user's row, so two tabs can't
 * end up with two defaults or more than the maximum.
 */
export class AddressService {
  constructor(private readonly deps: { prisma: PrismaClient }) {}

  /** The default first, then the newest. */
  list(userId: string): Promise<Address[]> {
    return this.deps.prisma.address.findMany({ where: { userId }, select: SELECT, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }, { id: "desc" }] });
  }

  /** The first address becomes the default automatically. */
  async create(userId: string, input: AddressInput & { isDefault?: boolean | undefined }): Promise<Address> {
    const { isDefault, ...fields } = input;
    return this.deps.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const count = await tx.address.count({ where: { userId } });
      if (count >= MAX_ADDRESSES) throw new AppError(409, "CONFLICT", `You can save up to ${MAX_ADDRESSES} addresses. Remove one to add another.`);
      const makeDefault = isDefault === true || count === 0;
      if (makeDefault) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      return tx.address.create({ data: { ...fields, userId, isDefault: makeDefault }, select: SELECT });
    });
  }

  /** Edit (the form sends every field). Past orders keep their own copy, so they don't change. */
  async update(userId: string, id: string, input: AddressInput): Promise<Address> {
    const { count } = await this.deps.prisma.address.updateMany({ where: { id, userId }, data: input });
    if (count === 0) throw notFound();
    return this.deps.prisma.address.findUniqueOrThrow({ where: { id }, select: SELECT });
  }

  /** Delete. If it was the default, the newest remaining address becomes the default. */
  async remove(userId: string, id: string): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const address = await tx.address.findFirst({ where: { id, userId }, select: { isDefault: true } });
      if (!address) throw notFound();
      await tx.address.delete({ where: { id } });
      if (address.isDefault) {
        const next = await tx.address.findFirst({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
        if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
  }

  /** "Set as default". */
  async setDefault(userId: string, id: string): Promise<Address> {
    return this.deps.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      if (!(await tx.address.findFirst({ where: { id, userId }, select: { id: true } }))) throw notFound();
      await tx.address.updateMany({ where: { userId, isDefault: true, NOT: { id } }, data: { isDefault: false } });
      return tx.address.update({ where: { id }, data: { isDefault: true }, select: SELECT });
    });
  }
}

/** Serializes one user's address changes (the row lock is released when the transaction ends). */
async function lockUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
}
