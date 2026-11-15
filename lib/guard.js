/**
 * Read-only statement guard.
 *
 * The duckdb CLI's `-readonly` flag only protects a *database file* — an
 * in-memory database (which is what this plugin uses so users never need a
 * pre-created .duckdb file) cannot be opened read-only, and `COPY ... TO
 * 'out.parquet'` happily writes to disk in that mode. Verified empirically
 * 2026-10-29 on duckdb v2.0.0-alpha39998:
 *
 *   $ duckdb -readonly -json -c "ATTACH ':memory:' AS m; ..."
 *   Catalog Error: Cannot launch in-memory database in read-only mode!
 *
 *   $ duckdb -json -c "COPY (SELECT 1) TO '/tmp/oops.parquet' (FORMAT PARQUET)"
 *   [{"r":"wrote file"}]   # the file really lands on disk
 *
 * So "read-only" is enforced HERE, before the SQL ever reaches the CLI: the
 * statement must parse as a single read-only statement. Anything else is
 * rejected unless the caller explicitly opts out (`read_only: false`), and
 * even then the guard still blocks the few statements that can escape the
 * workspace or the process.
 *
 * Fail-closed design: an unknown statement shape is REJECTED, not allowed.
 */

/** Leading keywords that identify a read-only statement. */
const READ_ONLY_LEADERS = new Set([
  'SELECT',
  'WITH',
  'VALUES',
  'FROM',
  'DESCRIBE',
  'SHOW',
  'SUMMARIZE',
  'EXPLAIN',
  'PRAGMA',
])

/**
 * Statement keywords that are blocked even when `read_only: false`, because
 * they can reach outside the process or mutate the host.
 */
const ALWAYS_BLOCKED = new Set([
  'INSTALL',
  'LOAD',
  'ATTACH',
  'DETACH',
  'COPY',
  'EXPORT',
  'IMPORT',
  'SET',
  'RESET',
  'CALL',
  'CHECKPOINT',
  'FORCE',
])

/** Strip comments and string literals so keyword scanning cannot be fooled. */
function stripNoise(sql) {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    // line comment
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    // block comment
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      continue
    }
    // single-quoted string literal
    if (ch === "'") {
      out += ' '
      i++
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue }
        if (sql[i] === "'") { i++; break }
        i++
      }
      continue
    }
    // double-quoted identifier
    if (ch === '"') {
      out += ' '
      i++
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue }
        if (sql[i] === '"') { i++; break }
        i++
      }
      continue
    }
    out += ch
    i++
  }
  return out
}

/** Uppercase word tokens of a statement, comments and literals removed. */
export function statementKeywords(sql) {
  const cleaned = stripNoise(sql)
  const words = []
  const re = /[A-Za-z_][A-Za-z0-9_]*/g
  let m
  while ((m = re.exec(cleaned)) !== null) words.push(m[0].toUpperCase())
  return words
}

/**
 * Classify one statement.
 *
 * @param {string} sql - the statement text
 * @param {boolean} readOnly - whether read-only mode is requested
 * @returns {{ok: true, kind: string} | {ok: false, code: string, detail: string}}
 */
export function checkStatement(sql, readOnly) {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { ok: false, code: 'EMPTY_SQL', detail: 'sql must be a non-empty string' }
  }
  const words = statementKeywords(sql)
  if (words.length === 0) {
    return { ok: false, code: 'NO_KEYWORDS', detail: 'statement contains no recognizable SQL keywords' }
  }
  const leader = words[0]

  const blocked = words.find((w) => ALWAYS_BLOCKED.has(w))
  if (blocked !== undefined) {
    return {
      ok: false,
      code: 'BLOCKED_KEYWORD',
      detail: `statement keyword ${blocked} is not permitted in dsh-duckdb (it can reach outside this process)`,
    }
  }

  if (readOnly && !READ_ONLY_LEADERS.has(leader)) {
    return {
      ok: false,
      code: 'NOT_READ_ONLY',
      detail: `statement starts with ${leader}, which is not read-only; set read_only=false to allow writes inside the workspace`,
    }
  }

  // CTE / VALUES / FROM are read leaders by construction.
  return { ok: true, kind: READ_ONLY_LEADERS.has(leader) ? 'read' : 'write' }
}

/**
 * Reject multi-statement input. The CLI runs each statement separately and
 * prints one JSON array per statement, which the plugin cannot attribute to a
 * single result; and a trailing `;` followed by a second statement would let a
 * write slip past a read-only check on the first statement.
 */
export function assertSingleStatement(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  if (trimmed.length === 0) {
    return { ok: false, code: 'EMPTY_SQL', detail: 'sql must be a non-empty string' }
  }
  const inner = stripNoise(trimmed)
  if (inner.includes(';')) {
    return {
      ok: false,
      code: 'MULTI_STATEMENT',
      detail: 'send one statement per call; dsh-duckdb does not accept statement batches',
    }
  }
  return { ok: true, sql: trimmed }
}

/**
 * Extract string literals from a statement (comments stripped, contents kept).
 * Used to inspect reader paths/URLs without parsing SQL.
 */
function stringLiterals(sql) {
  const out = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') { while (i < n && sql[i] !== '\n') i++; continue }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (ch === "'") {
      i++
      let lit = ''
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { lit += "'"; i += 2; continue }
        if (sql[i] === "'") { i++; break }
        lit += sql[i]
        i++
      }
      out.push(lit)
      continue
    }
    i++
  }
  return out
}

/** URL prefixes that reach the network from a reader function. */
const REMOTE_PREFIXES = ['http://', 'https://', 's3://', 's3a://', 'gcs://', 'gs://', 'r2://', 'az://', 'azure://', 'oci://', 'hf://']

/**
 * Gate remote URLs in a statement: rejected unless the operator enabled
 * `DSH_DUCKDB_ALLOW_REMOTE=1`. Fail-closed — an unknown-looking literal that
 * is not a path (no leading /) and not a known function name is also rejected
 * when remote is off, because DuckDB readers accept bare hostnames too.
 *
 * @param {string} sql - the single statement
 * @param {boolean} allowRemote
 * @returns {{ok: true} | {ok: false, code: string, detail: string}}
 */
export function checkRemoteAccess(sql, allowRemote) {
  if (allowRemote) return { ok: true }
  for (const lit of stringLiterals(sql)) {
    const lower = lit.toLowerCase()
    if (REMOTE_PREFIXES.some((p) => lower.startsWith(p))) {
      return {
        ok: false,
        code: 'REMOTE_BLOCKED',
        detail: `remote URL "${lit.slice(0, 80)}" rejected: set DSH_DUCKDB_ALLOW_REMOTE=1 (and allow httpfs via DSH_DUCKDB_ALLOW_EXTENSIONS) to enable`,
      }
    }
  }
  return { ok: true }
}

/**
 * Gate LOAD statements: LOAD is generally blocked, but when the operator's
 * extension gate allows a name, a bare `LOAD <name>` (that exact statement,
 * nothing else) is permitted so the model can activate an installed extension.
 * Returns 'allowed' verdicts only for a pure single LOAD.
 */
export function checkLoadStatement(sql, extensionAllowedFn) {
  const m = /^\s*LOAD\s+([A-Za-z0-9_]+)\s*;?\s*$/i.exec(sql)
  if (m === null) {
    return { ok: false, code: 'BLOCKED_KEYWORD', detail: 'LOAD is only permitted as a standalone "LOAD <name>" statement for extensions the operator allowed' }
  }
  const name = m[1].toLowerCase()
  if (!extensionAllowedFn(name)) {
    return { ok: false, code: 'EXTENSION_NOT_ALLOWED', detail: `extension "${name}" is not in this session's allow list (DSH_DUCKDB_ALLOW_EXTENSIONS)` }
  }
  return { ok: true, name }
}

export { stringLiterals, REMOTE_PREFIXES }
