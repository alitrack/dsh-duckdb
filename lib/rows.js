/**
 * Row-limit projection.
 *
 * A result set must never be dumped wholesale into the model's context. The
 * CLI query wraps the model's statement with
 *
 *   SELECT *, count(*) OVER () AS __duckdb_total FROM (<statement>) LIMIT n
 *
 * so one round-trip yields both the truncated rows and the true row count.
 * This module turns the CLI's JSON rows into the tool's canonical output,
 * stripping the injected column back out.
 */

/** Column name injected by the row-limit wrapper. Never model-visible. */
export const TOTAL_COLUMN = '__duckdb_total'

import { coerceCell } from './types.js'

/** Hard ceiling on rows returned regardless of the caller's request. */
export const MAX_ROWS_HARD_CAP = 1000

/** Default row limit when the model does not ask for one. */
export const DEFAULT_MAX_ROWS = 200

/**
 * Clamp a requested row limit into [1, HARD_CAP].
 * Non-numeric, zero, negative, fractional and absurd requests all fall back to
 * the default rather than erroring — the model should not have to guess.
 */
export function clampMaxRows(requested) {
  if (requested === undefined || requested === null) return DEFAULT_MAX_ROWS
  const n = Number(requested)
  if (!Number.isFinite(n)) return DEFAULT_MAX_ROWS
  const i = Math.floor(n)
  if (i < 1) return DEFAULT_MAX_ROWS
  return Math.min(i, MAX_ROWS_HARD_CAP)
}

/**
 * Project CLI JSON rows into the canonical output shape.
 *
 * @param {Array<Record<string, unknown>>} rows - rows from the CLI, each
 *   carrying the injected total column
 * @param {Array<{name: string, type: string}>} [columnTypes] - column types
 *   from a companion DESCRIBE, used to coerce numeric-string cells
 * @returns {{columns: string[], rows: unknown[][], row_count: number, truncated: boolean}}
 */
export function projectRows(rows, columnTypes) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { columns: [], rows: [], row_count: 0, truncated: false }
  }
  const first = rows[0]
  const columns = Object.keys(first).filter((c) => c !== TOTAL_COLUMN)
  const rowCount = Number(first[TOTAL_COLUMN] ?? rows.length)
  const typeByName = new Map((columnTypes ?? []).map((c) => [c.name, String(c.type).toUpperCase()]))
  const projected = rows.map((row) => columns.map((c) => {
    const cell = row[c]
    const type = typeByName.get(c)
    return type === undefined ? cell : coerceCell(cell, type)
  }))
  return {
    columns,
    rows: projected,
    row_count: Number.isFinite(rowCount) ? rowCount : rows.length,
    truncated: rowCount > rows.length,
  }
}

/**
 * Normalize one cell for lossless JSON transport.
 *
 * Values pass through unchanged for most types — duckdb's `-json` renders
 * BIGINT/DOUBLE/BOOLEAN/LIST/STRUCT as JSON natives and only HUGEINT and
 * DECIMAL as strings (see lib/types.js for the verified table). Type-aware
 * coercion lives there.
 */
function normalizeCell(value) {
  return value
}
