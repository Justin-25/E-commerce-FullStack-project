/**
 * Text for a LIKE / ILIKE '%…%' search, matched literally. Neither Prisma's `contains` nor a
 * hand-written ILIKE escapes "%" or "_", so a "%" typed in a search box would match everything
 * (caught by a test in 5c). Escape them, and the escape character itself.
 */
export const likeLiteral = (text: string): string => text.replace(/[\\%_]/g, "\\$&");
