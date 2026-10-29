/**
 * Workspace-safe path resolution for data files.
 *
 * Model-generated paths are untrusted input. Every path a model hands to a
 * dsh-duckdb tool is resolved here BEFORE it can reach the duckdb CLI, and
 * only paths that stay inside the session workspace survive. This module is
 * pure (no I/O beyond fs realpath) so it is unit-testable without spawning
 * anything.
 *
 * Rejection reasons (fail-closed, each returns a distinct code):
 *   EMPTY            - empty or whitespace-only input
 *   NOT_ABSOLUTE     - a relative path with no session cwd to resolve against
 *   ESCAPE           - resolves outside the workspace root (`..` traversal)
 *   SYMLINK_ESCAPE   - a symlink whose real target leaves the workspace
 *   MISSING          - the file does not exist
 *   NOT_A_FILE       - the path exists but is not a regular file
 */

import { isAbsolute, resolve, relative, sep } from 'node:path'
import { realpathSync, statSync } from 'node:fs'

/** Absolute path form of a workspace root, with symlinks resolved. */
export function canonicalRoot(root) {
  try {
    return realpathSync(resolve(root))
  } catch {
    return resolve(root)
  }
}

/**
 * Canonicalize one candidate path without requiring it to exist.
 * `realpathSync` on a non-existent path throws, so fall back to resolving the
 * closest existing ancestor. This keeps the escape check working for output
 * paths that do not exist yet.
 */
function canonicalizeExistingAncestor(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Validate one model-supplied file path against the workspace root.
 *
 * @param {string} raw - the path the model produced
 * @param {string} root - absolute workspace root (session cwd)
 * @returns {{ok: true, path: string} | {ok: false, code: string, detail: string}}
 */
export function validateWorkspaceFile(raw, root) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, code: 'EMPTY', detail: 'path must be a non-empty string' }
  }
  if (!isAbsolute(raw)) {
    return { ok: false, code: 'NOT_ABSOLUTE', detail: `path must be absolute: ${JSON.stringify(raw)}` }
  }
  const canonicalRootPath = canonicalRoot(root)
  // Resolve the lexical path first (catches `..` traversal without I/O), then
  // canonicalize so symlinks cannot be used to hop out of the workspace.
  const lexical = resolve(raw)
  const withinLexically = isWithin(lexical, canonicalRootPath)
  const real = canonicalizeExistingAncestor(lexical)
  const withinReally = isWithin(real, canonicalRootPath)
  if (!withinLexically) {
    return { ok: false, code: 'ESCAPE', detail: `${raw} resolves outside the workspace` }
  }
  if (!withinReally) {
    return { ok: false, code: 'SYMLINK_ESCAPE', detail: `${raw} resolves through a symlink outside the workspace` }
  }
  let stat
  try {
    stat = statSync(lexical)
  } catch {
    return { ok: false, code: 'MISSING', detail: `file not found: ${raw}` }
  }
  if (!stat.isFile()) {
    return { ok: false, code: 'NOT_A_FILE', detail: `not a regular file: ${raw}` }
  }
  return { ok: true, path: lexical }
}

/**
 * Whether `candidate` is inside `root` (or is the root itself).
 * Both arguments must already be absolute and canonical.
 */
export function isWithin(candidate, root) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Derive a stable SQL view name for an attached file: `f0`, `f1`, ...
 * Names are positional so the same file set always yields the same names and
 * the model can refer to them predictably.
 */
export function viewNameFor(index) {
  return `f${index}`
}
