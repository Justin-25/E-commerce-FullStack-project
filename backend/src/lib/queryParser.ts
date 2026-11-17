/**
 * Express "query parser" that only produces flat string values.
 *
 * - No nested objects: `?price[$gt]=0` stays the literal key "price[$gt]", so
 *   query values can never smuggle database operators or `__proto__` objects
 *   (NoSQL-injection / prototype-pollution guard).
 * - HTTP parameter pollution guard: a repeated key keeps only its LAST value
 *   (`?sort=price&sort=name` → "name"), unless the key is allowed to repeat
 *   (e.g. multi-select filters), in which case it becomes an array.
 * - At most `maxParams` parameters are read; extra ones are ignored.
 */
export type ParsedQuery = Record<string, string | string[]>;

export function createQueryParser(arrayKeys: readonly string[] = [], maxParams = 50) {
  const repeatable = new Set(arrayKeys);
  return (queryString: string): ParsedQuery => {
    const out: ParsedQuery = Object.create(null);
    let count = 0;
    for (const [key, value] of new URLSearchParams(queryString)) {
      if (++count > maxParams) break;
      if (repeatable.has(key)) {
        const prev = out[key];
        out[key] = prev === undefined ? [value] : [...(Array.isArray(prev) ? prev : [prev]), value];
      } else {
        out[key] = value;
      }
    }
    return out;
  };
}
