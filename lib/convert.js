/**
 * Format conversion — the only sanctioned COPY path.
 *
 * v0.1's guard blocks COPY outright (a COPY that survives would write a real
 * file even in an in-memory database). Conversion is a legitimate write the
 * model explicitly requests, so this module owns a *constructive* COPY: the
 * plugin builds the whole statement from validated parts — the model never
 * supplies SQL here, only paths and a format enum, so there is nothing to
 * smuggle.
 */

import { validateWorkspaceFile, validateWorkspaceDir } from './paths.js'
import { readerFor } from './cli.js'
import { dirname, resolve } from 'node:path'

/** Output formats the converter will emit. */
const FORMATS = new Set(['parquet', 'csv', 'json', 'duckdb'])

export { FORMATS }

/**
 * Validate a conversion request against the workspace.
 *
 * @returns {{ok: true, input: string, output: string, format: string} |
 *           {ok: false, code: string, detail: string}}
 */
export function validateConversion(rawInput, rawOutput, rawFormat, root) {
  if (typeof rawFormat !== 'string' || !FORMATS.has(rawFormat)) {
    return { ok: false, code: 'BAD_FORMAT', detail: `output_format must be one of: ${[...FORMATS].join(', ')}` }
  }

  const input = validateWorkspaceFile(rawInput, root)
  if (!input.ok) return { ok: false, code: input.code, detail: input.detail }

  if (typeof rawOutput !== 'string' || rawOutput.length === 0) {
    return { ok: false, code: 'BAD_OUTPUT', detail: 'output must be a non-empty path inside the workspace' }
  }
  if (!rawOutput.toLowerCase().endsWith(`.${rawFormat}`)) {
    return { ok: false, code: 'BAD_OUTPUT', detail: `output must end with .${rawFormat}` }
  }
  // Writing is dirFile-validated: a NEW output file is fine (it does not exist
  // yet), but its parent directory must exist inside the workspace so we never
  // create directories or resolve through symlinks pointing outside.
  const output = validateWorkspaceOutput(rawOutput, root)
  if (!output.ok) return { ok: false, code: output.code, detail: output.detail }

  if (input.path === output.path) {
    return { ok: false, code: 'SAME_PATH', detail: 'output must differ from input' }
  }

  return { ok: true, input: input.path, output: output.path, format: rawFormat }
}

/**
 * Build the COPY statement for a validated conversion. Constructive: the
 * statement is assembled entirely from validated parts.
 */
export function buildConvertStatement(input, output, format) {
  if (format === 'duckdb') {
    // A real database file, not a single-file format: export via COPY TO a
    // duckdb database is not a table-function target, so use ATTACH-less
    // EXPORT semantics through `COPY ... TO 'x.duckdb' (FORMAT duckdb)`,
    // which writes a single-table .duckdb file.
    return `COPY (SELECT * FROM ${readerFor(input)}) TO '${sqlQuote(output)}' (FORMAT duckdb)`
  }
  return `COPY (SELECT * FROM ${readerFor(input)}) TO '${sqlQuote(output)}' (FORMAT ${format})`
}

/** Double single quotes for a SQL string literal. */
function sqlQuote(value) {
  return String(value).replace(/'/g, "''")
}

/**
 * Validate a not-yet-existing output path inside the workspace: the parent
 * directory must be an existing directory inside the root.
 */
function validateWorkspaceOutput(raw, root) {
  const parent = dirname(resolve(raw))
  const verdict = validateWorkspaceDir(parent, root)
  if (!verdict.ok) return verdict
  return { ok: true, path: resolve(raw) }
}

