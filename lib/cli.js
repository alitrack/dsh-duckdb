/**
 * duckdb CLI invocation.
 *
 * v0.1 runs the local `duckdb` binary as a child process: no native Node
 * binding, no compilation, works wherever the CLI is installed. Each call
 * spawns a fresh in-memory database, attaches the validated data files as
 * views, runs exactly one statement, and exits.
 *
 * Verified CLI behaviour (duckdb v2.0.0-alpha39998, 2026-10-29):
 *   - `-json -c "<sql>"` prints one JSON array per statement
 *   - an in-memory database CANNOT be opened with `-readonly`
 *   - `-unsigned` is required to LOAD locally built extensions
 *   - a failing statement exits 1 with the message on stderr
 */

import { spawn } from 'node:child_process'
import { viewNameFor } from './paths.js'
import { statementKeywords } from './guard.js'

/** Environment variable that can point the plugin at a specific binary. */
export const DUCKDB_BIN_ENV = 'DSH_DUCKDB_BIN'

/** Default binary name. */
export const DEFAULT_DUCKDB_BIN = 'duckdb'

/**
 * Build the argv for one query invocation.
 *
 * The model's statement is wrapped so that (a) data files become views named
 * f0, f1, ... and (b) the row limit is applied with a window count that also
 * reports the true total. Wrapping happens on OUR side — the model never sees
 * the injected SQL, so it cannot be used to smuggle a second statement past
 * the guard (which already rejects `;`).
 *
 * @param {object} spec
 * @param {string} spec.statement - the guarded single statement
 * @param {string[]} spec.files - validated absolute file paths
 * @param {number} spec.maxRows - clamped row limit
 * @param {boolean} spec.unsigned - pass `-unsigned` (needed for LOAD)
 * @param {boolean} [spec.wrap=true] - false emits the statement verbatim
 * @returns {string[]} argv (without the binary)
 */
export function buildArgv({ statement, files, maxRows, unsigned, wrap = true }) {
  const sql = wrap ? wrapStatement(statement, files, maxRows) : statement
  const argv = []
  if (unsigned) argv.push('-unsigned')
  argv.push('-json', '-c', sql)
  return argv
}

/**
 * Wrap the statement: create views for the data files, then apply the
 * row-limit projection.
 *
 * The row-limit projection is a SELECT wrapper, so it can only be applied to
 * a statement that is itself a query. A DDL/DML statement (CREATE / INSERT /
 * UPDATE / DELETE / ...) is NOT an expression — wrapping it produces
 * `Parser Error: syntax error at or near "CREATE"` (verified 2026-10-29). Such
 * statements therefore run verbatim: they cannot return rows, so there is
 * nothing to truncate, and the caller asked for them explicitly via
 * `read_only: false`.
 */
export function wrapStatement(statement, files, maxRows) {
  const prelude = files.map((file, index) => {
    const view = viewNameFor(index)
    return `CREATE VIEW ${view} AS SELECT * FROM ${readerFor(file)}`
  })
  const limited = isQueryStatement(statement)
    ? `SELECT *, count(*) OVER () AS __duckdb_total FROM (${statement}) LIMIT ${maxRows}`
    : statement
  return [...prelude, limited].join(';\n')
}

/** Statement leaders that denote a query (safe to wrap in a SELECT). */
const QUERY_LEADERS = new Set([
  'SELECT', 'WITH', 'VALUES', 'FROM', 'DESCRIBE', 'SHOW', 'SUMMARIZE', 'EXPLAIN', 'PRAGMA',
])

/**
 * Whether a statement is a query that the row-limit wrapper can enclose.
 * Unknown leaders are treated as non-queries so they run verbatim rather than
 * producing a parser error.
 */
export function isQueryStatement(statement) {
  const words = statementKeywords(statement)
  return words.length > 0 && QUERY_LEADERS.has(words[0])
}

/**
 * Pick the duckdb reader function for a file extension.
 * Unknown extensions fall back to read_csv_auto, which is duckdb's most
 * forgiving reader and produces a useful error for genuinely bad input.
 */
export function readerFor(file) {
  const lower = file.toLowerCase()
  if (lower.endsWith('.parquet')) return `read_parquet('${escapeSqlString(file)}')`
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) return `read_csv_auto('${escapeSqlString(file)}')`
  if (lower.endsWith('.json') || lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return `read_json_auto('${escapeSqlString(file)}')`
  if (lower.endsWith('.duckdb') || lower.endsWith('.db')) return `read_duckdb('${escapeSqlString(file)}')`
  return `read_csv_auto('${escapeSqlString(file)}')`
}

/** Double single quotes for a SQL string literal. */
export function escapeSqlString(value) {
  return String(value).replace(/'/g, "''")
}

/**
 * Run one query and parse the CLI's JSON output.
 *
 * @param {object} spec
 * @param {string} spec.statement - the guarded single statement
 * @param {string[]} spec.files - validated absolute file paths
 * @param {number} spec.maxRows - clamped row limit
 * @param {boolean} [spec.unsigned] - pass `-unsigned` (needed for LOAD)
 * @param {boolean} [spec.wrap] - wrap the statement with the row-limit
 *   projection (default true). Pass false when the caller has already built a
 *   complete statement — wrapping it again would apply a second LIMIT and
 *   silently truncate the result (this bit duckdb_schema's DESCRIBE).
 * @returns {Promise<{ok: true, rows: unknown[]} | {ok: false, code: string, detail: string, exitCode?: number, stderr?: string}>}
 */
export function runQuery({ statement, files, maxRows, unsigned = false, timeoutMs = 30000, signal, binary, wrap = true }) {
  return new Promise((resolvePromise) => {
    const bin = binary ?? process.env[DUCKDB_BIN_ENV] ?? DEFAULT_DUCKDB_BIN
    const argv = buildArgv({ statement, files, maxRows, unsigned, wrap })
    let settled = false
    let stdout = ''
    let stderr = ''
    let child

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolvePromise(result)
    }

    try {
      child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({
        ok: false,
        code: 'SPAWN_FAILED',
        detail: `could not start duckdb (${bin}): ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, code: 'TIMEOUT', detail: `query exceeded ${timeoutMs}ms and was killed` })
    }, timeoutMs)

    const onAbort = () => {
      child.kill('SIGKILL')
      finish({ ok: false, code: 'ABORTED', detail: 'query aborted' })
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })

    child.on('error', (error) => {
      finish({
        ok: false,
        code: 'SPAWN_FAILED',
        detail: `could not run duckdb (${bin}): ${error instanceof Error ? error.message : String(error)}`,
      })
    })

    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      if (code === 0) {
        const parsed = parseCliJson(stdout)
        if (!parsed.ok) {
          finish({ ok: false, code: 'BAD_OUTPUT', detail: parsed.detail, stderr })
          return
        }
        // Our wrapper emits the query plus (for attached files) view-creating
        // prelude statements. DDL produces no JSON array of its own, so a
        // non-query statement legitimately yields zero arrays — that is a
        // successful write, not a malformed response. If more than one array
        // arrives, the guard should have rejected the batch; fail loud rather
        // than silently drop data.
        if (parsed.arrays.length > 1) {
          finish({
            ok: false,
            code: 'UNEXPECTED_OUTPUT_SHAPE',
            detail: `expected one result set, got ${parsed.arrays.length}`,
            stderr,
          })
          return
        }
        finish({ ok: true, rows: parsed.arrays[0] ?? [] })
        return
      }
      finish({
        ok: false,
        code: 'CLI_ERROR',
        detail: firstErrorLine(stderr),
        exitCode: code ?? undefined,
        stderr,
      })
    })
  })
}

/**
 * Parse the CLI's `-json` output: a sequence of JSON arrays, possibly
 * pretty-printed across lines (the CLI does pretty-print). Concatenating the
 * raw text and scanning bracket depth is fragile, so instead we use a small
 * streaming JSON-array reader.
 */
export function parseCliJson(stdout) {
  const text = stdout.trim()
  if (text.length === 0) return { ok: true, arrays: [] }
  const arrays = []
  let index = 0
  const n = text.length
  while (index < n) {
    while (index < n && /\s/.test(text[index])) index++
    if (index >= n) break
    if (text[index] !== '[') {
      return { ok: false, detail: `unexpected duckdb output at offset ${index}: ${text.slice(index, index + 80)}` }
    }
    const end = findArrayEnd(text, index)
    if (end === -1) {
      return { ok: false, detail: 'unterminated JSON array in duckdb output' }
    }
    try {
      arrays.push(JSON.parse(text.slice(index, end + 1)))
    } catch (error) {
      return { ok: false, detail: `invalid JSON in duckdb output: ${error instanceof Error ? error.message : String(error)}` }
    }
    index = end + 1
  }
  return { ok: true, arrays }
}

/** Index of the `]` closing the array that starts at `start`, or -1. */
function findArrayEnd(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** First meaningful line of a duckdb error message. */
function firstErrorLine(stderr) {
  const lines = String(stderr).split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 0) return 'duckdb reported an error with no message'
  return lines[0]
}
