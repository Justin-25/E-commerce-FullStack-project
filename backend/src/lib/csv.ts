/**
 * CSV files people open in Excel or Google Sheets (RFC 4180, UTF-8 with a byte-order mark so
 * Excel reads "₱" and "ñ" correctly).
 *
 * Formula injection: a cell starting with = + - @ (or a tab / carriage return) is run as a
 * formula by spreadsheet apps, so a product named `=HYPERLINK("http://evil…")` could act when
 * the seller opens the file. Such cells get a leading apostrophe, which shows them as plain
 * text (OWASP's advice). Numbers are written by us and never negative, so they never need it.
 */
export type CsvValue = string | number | null;

/** The byte-order mark that tells Excel the file is UTF-8. */
const BOM = String.fromCharCode(0xfeff);
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: CsvValue): string {
  if (value === null) return "";
  let text = String(value);
  if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: CsvValue[][]): string {
  return `${BOM}${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** Centavos as a plain number of pesos ("9998.00"), which spreadsheets add up. */
export const pesos = (centavos: number) => (centavos / 100).toFixed(2);
