/**
 * Proves the test database works with our Prisma client: the features the
 * sign-in code relies on (UUID v7 ids, unique errors, transactions, enums,
 * timestamps, raw SQL) behave like they do on Neon.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "../../src/generated/prisma/client.js";
import { createTestDb, type TestDb } from "../support/testDb.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => db?.close());

describe("test database (Prisma on PGlite locally, real Postgres in CI)", () => {
  it("creates a row with a UUID v7 id and reads it back", async () => {
    const user = await db.prisma.user.create({ data: { email: "maria@example.com", name: "Maria" } });
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(user.role).toBe("CUSTOMER");
    expect(user.createdAt).toBeInstanceOf(Date);
    const found = await db.prisma.user.findUnique({ where: { email: "maria@example.com" } });
    expect(found?.id).toBe(user.id);
  });

  it("reports a duplicate email as Prisma error P2002", async () => {
    const err = await db.prisma.user.create({ data: { email: "maria@example.com", name: "Again" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
  });

  it("enforces the hand-written CHECK rules (lowercase email)", async () => {
    await expect(db.prisma.user.create({ data: { email: "Upper@Example.com", name: "X" } })).rejects.toThrow();
  });

  it("rolls back an interactive transaction when it throws", async () => {
    await expect(
      db.prisma.$transaction(async (tx) => {
        await tx.user.create({ data: { email: "rollback@example.com", name: "R" } });
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");
    expect(await db.prisma.user.count({ where: { email: "rollback@example.com" } })).toBe(0);
  });

  it("runs raw SQL and updates with conditions atomically", async () => {
    const rows = await db.prisma.$queryRaw<{ one: number }[]>`SELECT 1::int AS one`;
    expect(rows[0]?.one).toBe(1);
    const { count } = await db.prisma.user.updateMany({ where: { email: "maria@example.com", emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
    expect(count).toBe(1);
    const again = await db.prisma.user.updateMany({ where: { email: "maria@example.com", emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
    expect(again.count).toBe(0);
  });
});
