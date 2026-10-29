/**
 * Type-coercing JSON renderer for duckdb CLI output.
 *
 * Verified on duckdb v2.0.0-alpha39998 (2026-10-29): `-json` renders most
 * types as JSON natives, but a few come back as STRINGS even though they are
 * not textual data:
 *
 *   HUGEINT  -> "300"        DECIMAL -> "1.50"       BLOB -> "ab"
 *   (DATE/TIMESTAMP/TIME/INTERVAL/UUID are legitimately strings)
 *
 * A HUGEINT or DECIMAL arriving as "300" is a number the model will read as
 * text — harmless for display, wrong if the model does arithmetic on it in a
 * follow-up. Since the tool's canonical value is JSON, we coerce the known
 * numeric-but-stringified cases back to JSON numbers, and leave genuinely
 * textual types (dates, uuids, blobs) alone.
 *
 * The coercion is deliberately narrow: only exact numeric shapes are
 * converted, so a VARCHAR column holding "300" (a zip code, a phone number)
 * is never silently turned into a number — that would corrupt the data.
 */

/** Types whose CLI JSON rendering is a string but whose value is numeric. */
const NUMERIC_STRING_TYPES = new Set(['HUGEINT', 'DECIMAL'])

/**
 * Coerce cells that came back stringified for a numeric duckdb type.
 *
 * @param {unknown} value - the cell from the CLI
 * @param {string} type - the duckdb column type (upper-cased by the caller)
 * @returns {unknown} the coerced cell
 */
export function coerceCell(value, type) {
  if (typeof value !== 'string') return value
  if (!NUMERIC_STRING_TYPES.has(type)) return value
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value
  return Number(value)
}

/**
 * Normalize one numeric-looking string only when it round-trips exactly.
 * Exported for tests.
 */
export function numericRoundTrip(value) {
  const n = Number(value)
  return Number.isFinite(n) ? String(n) === value || String(n) === `${value}.0` : false
}
