/**
 * Extension & network gate — the platform face's capability switchboard.
 *
 * v0.1 pinned the engine down: no extensions, no network, everything local.
 * The platform story needs the opposite axis — the operator decides which
 * capabilities the session gets, and the model cannot turn any of them on by
 * itself:
 *
 *   - `DSH_DUCKDB_ALLOW_EXTENSIONS`  comma list (or "none"/"all") of extension
 *     names the SQL may LOAD. Install/IMPORT stay blocked — only LOAD of
 *     already-installed extensions, from DuckDB's own signed repositories.
 *   - `DSH_DUCKDB_ALLOW_REMOTE`      "1" to allow http(s)/s3/gcs/r2 URLs in
 *     readers (requires httpfs in the allow list to be usable).
 *
 * Both default OFF. The gate resolves once at apply() time (tools have no hot
 * reload); its verdict feeds the systemPrompt section so the model knows what
 * exists and how to ask for more.
 */

/** Env var names. */
export const ALLOW_EXTENSIONS_ENV = 'DSH_DUCKDB_ALLOW_EXTENSIONS'
export const ALLOW_REMOTE_ENV = 'DSH_DUCKDB_ALLOW_REMOTE'

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   allowExtensions: string[] | 'all',
 *   allowRemote: boolean,
 *   unknownTokens: string[],
 * }}
 */
export function resolveGate(env = process.env) {
  const raw = env[ALLOW_EXTENSIONS_ENV]
  let allowExtensions = []
  let unknownTokens = []
  if (typeof raw === 'string' && raw.trim() !== '') {
    const token = raw.trim().toLowerCase()
    if (token === 'all') {
      allowExtensions = 'all'
    } else if (token !== 'none') {
      allowExtensions = [...new Set(token.split(',').map((s) => s.trim()).filter((s) => s.length > 0))]
      unknownTokens = allowExtensions.filter((s) => !/^[a-z0-9_]+$/.test(s))
    }
  }
  const allowRemote = env[ALLOW_REMOTE_ENV] === '1' || env[ALLOW_REMOTE_ENV] === 'true'
  return { allowExtensions, allowRemote, unknownTokens }
}

/** Extension names that reach the network once loaded. */
const NETWORK_EXTENSIONS = new Set(['httpfs', 'aws', 'azure', 'mysql_scanner', 'postgres_scanner', 'oci_client'])

/**
 * Is `name` loadable in this session? (allowExtensions === 'all' permits any
 * installed extension; the SQL guard separately blocks INSTALL.)
 */
export function extensionAllowed(name, gate) {
  const n = String(name).toLowerCase()
  if (gate.allowExtensions === 'all') return true
  return gate.allowExtensions.includes(n)
}

/**
 * Does this gate permit any remote URL reads at all? Advisory only — the real
 * enforcement is: remote URLs in a statement are rejected unless allowRemote,
 * and loading httpfs requires the extension gate.
 */
export function remoteAllowed(gate) {
  return gate.allowRemote
}

/** Human/mode-facing summary of the gate for the systemPrompt section. */
export function describeGate(gate) {
  if (gate.allowExtensions === 'all') {
    return 'extension gate: ALL installed extensions may be LOADed (INSTALL stays blocked)'
  }
  if (gate.allowExtensions.length === 0) {
    return 'extension gate: closed — no extension may be loaded this session'
  }
  return `extension gate: LOAD permitted for [${gate.allowExtensions.join(', ')}] only`
}

export { NETWORK_EXTENSIONS }
