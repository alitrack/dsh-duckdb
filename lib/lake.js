/**
 * duckdb_lake — persistent, cross-session dataset assets via DuckLake.
 *
 * v0.1–v0.4 state lives and dies with the CLI process: every call is a fresh
 * engine, and the session catalog only replays ephemeral views. A lake is the
 * asset layer — data written once and queried by any later session:
 *
 *   lake_create(name)             → ATTACH '<ws>/lake-data/<name>.ducklake'
 *   lake_write(alias→lake.table)  → INSERT/CREATE TABLE AS inside the lake
 *   query: lake.table via plain duckdb_query (ATTACH in the view prelude)
 *
 * Layout: lakes live under <workspace>/lake-data/, one .ducklake per asset.
 * The catalog records lake names so duckdb_catalog shows them; queries get
 * the ATTACH replayed as a prelude exactly like file aliases.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runQuery } from './cli.js'

const LAKE_DIR = 'lake-data'
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
const TABLE_RE = /^[a-z][a-z0-9_]{0,63}$/

export function lakeDir(root) {
  return join(root, LAKE_DIR)
}

export function validateLakeName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return { ok: false, code: 'BAD_LAKE_NAME', detail: 'lake name must match /^[a-z][a-z0-9_]{0,63}$/' }
  }
  return { ok: true }
}

export function validateTableName(name) {
  if (typeof name !== 'string' || !TABLE_RE.test(name)) {
    return { ok: false, code: 'BAD_TABLE_NAME', detail: 'table name must match /^[a-z][a-z0-9_]{0,63}$/' }
  }
  return { ok: true }
}

/** Absolute path of the lake file for a validated name. */
export function lakePath(root, name) {
  return join(lakeDir(root), `${name}.ducklake`)
}

/**
 * Create (or confirm) a lake. Idempotent: an existing lake is reused as-is
 * rather than recreated — assets are never silently destroyed.
 */
export async function lakeCreate({ root, name, binary, timeoutMs = 30000 }) {
  const v = validateLakeName(name)
  if (!v.ok) return v
  const dir = lakeDir(root)
  mkdirSync(dir, { recursive: true })
  const path = lakePath(root, name)
  const fresh = !existsSync(path)
  // ATTACH alone creates the lake files when missing, and is a no-op re-attach
  // otherwise (per-call fresh process, so no conflict with a live ATTACH).
  const result = await runQuery({
    statement: `ATTACH '${path.replace(/'/g, "''")}' AS __lake_${name} (TYPE DUCKLAKE)`,
    wrap: false,
    timeoutMs,
    ...(binary !== undefined ? { binary } : {}),
  })
  if (!result.ok) return { ok: false, code: result.code, detail: result.detail }
  return { ok: true, path, fresh }
}

/**
 * Copy a dataset into a lake table. `source` is a fully validated, absolute
 * path inside the workspace (the tool layer resolves it — never the model's
 * raw string). Write happens as CREATE TABLE ... AS via the lake ATTACH;
 * DROP first when replace=true (explicit, never silent).
 */
export async function lakeWrite({ root, name, table, source, replace = false, binary, timeoutMs = 120000 }) {
  const vn = validateLakeName(name)
  if (!vn.ok) return vn
  const vt = validateTableName(table)
  if (!vt.ok) return vt
  const path = lakePath(root, name)
  if (!existsSync(path)) return { ok: false, code: 'NO_LAKE', detail: `lake "${name}" does not exist — create it first with lake_create` }

  const attach = `ATTACH '${path.replace(/'/g, "''")}' AS __lake (TYPE DUCKLAKE)`
  const target = `__lake.${table}`
  const drop = replace ? `DROP TABLE IF EXISTS ${target}; ` : ''
  // read_* needs the source inside the statement; source is workspace-local
  // and pre-validated, so embedding the escaped absolute path is safe.
  const from = source.endsWith('.parquet')
    ? `read_parquet('${source.replace(/'/g, "''")}')`
    : source.endsWith('.json') || source.endsWith('.jsonl') || source.endsWith('.ndjson')
      ? `read_json('${source.replace(/'/g, "''")}', auto_schema=true)`
      : `read_csv('${source.replace(/'/g, "''")}', auto_detect = true)`
  const create = replace
    ? `CREATE OR REPLACE TABLE ${target} AS SELECT * FROM ${from}`
    : `CREATE TABLE ${target} AS SELECT * FROM ${from}`
  const result = await runQuery({
    statement: `${attach}; ${drop}${create}`,
    wrap: false,
    timeoutMs,
    ...(binary !== undefined ? { binary } : {}),
  })
  if (!result.ok) {
    // create-only on an existing table surfaces as a catalog error; keep the
    // raw detail but tag the common case for the model to self-correct.
    const existsCase = /already exists/i.test(result.detail ?? '')
    return { ok: false, code: existsCase ? 'TABLE_EXISTS' : result.code, detail: result.detail }
  }
  return { ok: true, table, replace: Boolean(replace) }
}

/** ATTACH prelude lines for lakes registered in this workspace's catalog. */
export function lakePrelude(catalog, root) {
  const lakes = catalog.listLakes ? catalog.listLakes(root) : []
  return lakes
    .map((l) => (typeof l === 'string' ? l : l.name))
    .filter((name) => NAME_RE.test(name))
    .map((name) => `ATTACH '${lakePath(root, name).replace(/'/g, "''")}' AS lake_${name} (TYPE DUCKLAKE)`)
}
