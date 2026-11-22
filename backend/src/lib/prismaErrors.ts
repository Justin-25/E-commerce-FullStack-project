/**
 * A unique index refused the write (Prisma's P2002, or PostgreSQL's own message when it
 * comes through a raw query). Used where two requests at the same moment race for the same
 * row and the database, not a lookup beforehand, decides the winner.
 */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === "P2002" || /unique constraint|duplicate key/i.test(e?.message ?? "");
}
