/**
 * Integration for the extension/network gate, against the REAL duckdb CLI.
 * Requires network for the federation arm.
 *
 * Run: DSH_DUCKDB_BIN=$HOME/duckdb200/duckdb node tests/integration-gate.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import process from 'node:process'

const bin = process.env.DSH_DUCKDB_BIN
if (!bin) { console.error('set DSH_DUCKDB_BIN'); process.exit(1) }

const { apply } = await import('../index.js')

function makePlugin(extraEnv = {}) {
  const saved = {}
  for (const k of Object.keys(extraEnv)) { saved[k] = process.env[k]; process.env[k] = extraEnv[k] }
  const registered = []
  const sections = []
  const ctx = {
    tools: { register: (d) => { registered.push(d); return () => {} } },
    systemPrompt: { section: (s) => { sections.push(s) } },
  }
  apply(ctx)
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
  return { tools: Object.fromEntries(registered.map((t) => [t.name, t])), sections }
}

const ws = mkdtempSync(join(tmpdir(), 'dsh-gate-'))
const exec = () => ({ signal: new AbortController().signal, agent: { session: { header: { cwd: ws } } } })

try {
  writeFileSync(join(ws, 'a.csv'), 'x\n1\n')

  // 1. closed gate: remote URL rejected before any CLI call
  {
    const { tools } = makePlugin()
    const r = await tools.duckdb_query.execute(
      { sql: "SELECT count(*) FROM read_parquet('https://duckdb.org/data/prices.parquet')" }, exec())
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'REMOTE_BLOCKED')
    console.log('✓ closed gate: REMOTE_BLOCKED')
    // LOAD smuggling still blocked
    const load = await tools.duckdb_query.execute({ sql: 'LOAD httpfs' }, exec())
    assert.equal(load.ok, false)
    assert.equal(load.error.code, 'BLOCKED_KEYWORD')
    console.log('✓ closed gate: model LOAD blocked')
  }

  // 2. open gate: federated https read works via prelude
  {
    const { tools } = makePlugin({ DSH_DUCKDB_ALLOW_EXTENSIONS: 'httpfs', DSH_DUCKDB_ALLOW_REMOTE: '1' })
    const r = await tools.duckdb_query.execute(
      { sql: "SELECT count(*) AS n FROM read_parquet('https://duckdb.org/data/prices.parquet')" }, exec())
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.rows[0][0], 9)
    console.log('✓ open gate: federated https parquet read (n=9)')

    const ext = await tools.duckdb_extensions.execute({ filter: 'allowed' }, exec())
    assert.equal(ext.ok, true)
    const httpfs = ext.extensions.find((e) => e.name === 'httpfs')
    assert.equal(httpfs.allowed, true)
    assert.equal(httpfs.installed, true)
    assert.equal(httpfs.active, true)
    console.log('✓ duckdb_extensions: httpfs allowed+installed+active')

    // local query still works with prelude active
    const local = await tools.duckdb_query.execute(
      { sql: 'SELECT count(*) AS n FROM f0', files: [join(ws, 'a.csv')] }, exec())
    assert.equal(local.rows[0][0], 1)
    console.log('✓ prelude does not break local queries')
  }

  // 3. allowed-but-not-installed extension: prelude skips it silently
  {
    const { tools } = makePlugin({ DSH_DUCKDB_ALLOW_EXTENSIONS: 'httpfs,definitely_not_installed_xyz' })
    const r = await tools.duckdb_query.execute({ sql: 'SELECT 42 AS ok' }, exec())
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.rows[0][0], 42)
    console.log('✓ missing allowed extension is skipped, query unaffected')

    const ext = await tools.duckdb_extensions.execute({}, exec())
    const missing = ext.extensions.find((e) => e.name === 'definitely_not_installed_xyz')
    assert.equal(missing.allowed, true)
    assert.equal(missing.installed, false)
    assert.equal(missing.active, false)
    console.log('✓ duckdb_extensions reports not-installed correctly')
  }

  console.log('\nALL GATE INTEGRATION CHECKS PASSED')
} finally {
  rmSync(ws, { recursive: true, force: true })
}
