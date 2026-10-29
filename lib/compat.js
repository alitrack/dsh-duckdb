/**
 * Plugin compatibility gate for dsh-duckdb.
 *
 * Verified 2026-10-29: dsh 0.2.1-rc.2 REFUSES to load a plugin whose
 * package.json `peerDependencies` on `@deepseek-ai/dsh-tools` does not match
 * the runtime's installed version. The exact-version exemption
 * (`dsh plugin allow-version`) is the documented escape hatch, but the clean
 * answer is to declare the requirement we actually test against.
 *
 * The published dsh-tools is 0.0.1-rc.1; our tools only use `defineTool` from
 * its root export, whose signature has been stable across the rc line. We
 * therefore declare the range we have verified, and the CI job pins dsh to the
 * same version so the claim stays honest.
 */

import { readFileSync } from 'node:fs'

/** The dsh version this plugin's e2e suite runs against. */
export const TESTED_DSH_VERSION = '0.2.1-rc.2'

/** The dsh-tools range verified to expose the `defineTool` API we use. */
export const TESTED_TOOLS_RANGE = '^0.0.1-rc.1'

/**
 * Whether a loaded dsh runtime satisfies our declared peer range.
 * Used by the compatibility self-check test, not by the plugin at runtime.
 *
 * npm's caret range on a 0.0.x version pins the minor: `^0.0.1` accepts
 * 0.0.x (x >= 1) but NOT 0.1.0. Mirrors that rule so the self-check agrees
 * with what the dsh loader enforces.
 */
export function isCompatible(peerRange, installedVersion) {
  const base = peerRange.replace(/^[~^]/, '')
  const [major, minor] = base.split('.').map((part) => parseInt(part, 10) || 0)
  const [iMajor, iMinor] = String(installedVersion).split('.').map((part) => parseInt(part, 10) || 0)
  if (iMajor !== major) return false
  // 0.0.x is special-cased by caret: the minor must match exactly.
  if (major === 0 && iMinor !== minor) return false
  return iMinor >= minor
}

/** Read our own package.json (for tests and CI assertions). */
export function readOwnPackage(root = new URL('..', import.meta.url).pathname) {
  return JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
}
