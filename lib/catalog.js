/**
 * Attachment catalog — the "platform face" persistence layer.
 *
 * The duckdb CLI is a fresh process per call, so what persists across calls is
 * metadata only: an alias → validated-file-list mapping keyed by workspace
 * root. Query calls replay `CREATE VIEW` preludes from this mapping (the same
 * replay pattern v0.1 already used for its own `files` argument).
 *
 * Scope: one catalog per plugin instance. Aliases are single SQL identifiers,
 * validated here, so they can be interpolated into preludes safely.
 */

import { globSync } from 'node:fs'
import { validateWorkspaceFile } from './paths.js'

/** Valid alias: a single lowercase SQL identifier segment. */
const ALIAS_RE = /^[a-z][a-z0-9_]{0,63}$/

/** Hard cap on files per alias so a fat glob cannot flood a prelude. */
const MAX_FILES_PER_ALIAS = 64

export class Catalog {
  constructor() {
    /** @type {Map<string, { alias: string, root: string, files: string[], createdAt: number }>} */
    this.entries = new Map()
    /** @type {Map<string, { name: string, root: string, createdAt: number }>} */
    this.lakes = new Map()
  }

  /**
   * Register a persistent lake for a workspace. Idempotent per (name, root).
   * @returns {{ok: true, name: string} | {ok: false, code: string, detail: string}}
   */
  registerLake(name, root) {
    if (typeof name !== 'string' || name.length === 0) {
      return { ok: false, code: 'BAD_LAKE_NAME', detail: 'lake name must be a non-empty string' }
    }
    const key = `${root}::${name}`
    if (!this.lakes.has(key)) {
      this.lakes.set(key, { name, root, createdAt: Date.now() })
    }
    return { ok: true, name }
  }

  /** Lake names visible to one workspace root. */
  listLakes(root) {
    return [...this.lakes.values()]
      .filter((entry) => entry.root === root)
      .map(({ name, createdAt }) => ({ name, created_at: createdAt }))
  }

  /**
   * Register files (exact paths or glob patterns) under an alias.
   * All-or-nothing: one bad path rejects the whole call.
   *
   * @returns {{ok: true, alias: string, files: string[]} | {ok: false, code: string, detail: string}}
   */
  attach(rawFiles, alias, root) {
    if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
      return { ok: false, code: 'BAD_FILES', detail: 'files must be a non-empty array of absolute paths or glob patterns' }
    }
    if (typeof alias !== 'string' || !ALIAS_RE.test(alias)) {
      return { ok: false, code: 'BAD_ALIAS', detail: `alias must match ${ALIAS_RE} (a single lowercase identifier)` }
    }
    if (this.entries.has(alias)) {
      return { ok: false, code: 'ALIAS_TAKEN', detail: `alias "${alias}" is already attached; pick another name` }
    }

    const resolved = []
    for (const raw of rawFiles) {
      if (typeof raw !== 'string' || raw.length === 0) {
        return { ok: false, code: 'BAD_FILES', detail: 'files entries must be non-empty strings' }
      }
      // Globs contain metacharacters: expand first, then validate each hit
      // against the workspace — a glob can never smuggle a path the validator
      // would reject, because every expanded hit goes through it.
      const isGlob = /[*?[{]/.test(raw)
      const candidates = isGlob ? expandGlob(raw) : [raw]
      if (candidates.length === 0) {
        return { ok: false, code: 'GLOB_NO_MATCH', detail: `glob matched nothing: ${raw}` }
      }
      for (const candidate of candidates) {
        const verdict = validateWorkspaceFile(candidate, root)
        if (!verdict.ok) return { ok: false, code: verdict.code, detail: verdict.detail }
        resolved.push(verdict.path)
      }
      if (resolved.length > MAX_FILES_PER_ALIAS) {
        return { ok: false, code: 'TOO_MANY_FILES', detail: `more than ${MAX_FILES_PER_ALIAS} files after glob expansion` }
      }
    }

    this.entries.set(alias, { alias, root, files: resolved, createdAt: Date.now() })
    return { ok: true, alias, files: resolved }
  }

  /**
   * Resolve an alias to its file list. The alias must have been attached
   * within the same workspace root — a catalog entry from another session's
   * workspace is invisible, not an escape hatch.
   *
   * @returns {{ok: true, files: string[], createdAt: number} | {ok: false, code: string, detail: string}}
   */
  resolve(alias, root) {
    const entry = this.entries.get(alias)
    if (entry === undefined || entry.root !== root) {
      return { ok: false, code: 'UNKNOWN_ALIAS', detail: `no attachment named "${alias}" in this workspace; call duckdb_attach first, or list with duckdb_catalog` }
    }
    return { ok: true, files: entry.files, createdAt: entry.createdAt }
  }

  /** List entries visible to one workspace root. */
  list(root) {
    return [...this.entries.values()]
      .filter((entry) => entry.root === root)
      .map(({ alias, files, createdAt }) => ({ alias, files, file_count: files.length, created_at: createdAt }))
  }
}

/**
 * Expand a glob pattern to absolute-ish candidate paths, keeping order
 * deterministic (sorted) so view names f0, f1, ... are stable across calls.
 */
function expandGlob(pattern) {
  try {
    return [...globSync(pattern, { withFileTypes: false })].sort()
  } catch {
    return []
  }
}

/** Test hook: the alias rule, exported so tests pin the exact contract. */
export { ALIAS_RE, MAX_FILES_PER_ALIAS }
