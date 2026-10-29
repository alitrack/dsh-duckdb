/**
 * Key-free e2e harness for dsh-duckdb.
 *
 * Drives the plugin's Cordis contract directly: builds a fake `ctx` that
 * captures registrations, calls `apply(ctx)`, then invokes each registered
 * tool's `execute` with a realistic fake `exec` (session cwd + AbortSignal).
 * No model, no API key, no dsh runtime.
 *
 * This is NOT a substitute for the full headless e2e (which needs a provider
 * key); it is the layer that catches contract breakage — wrong inject list,
 * schema that fails `assertSupportedJsonSchema`, tools that throw instead of
 * returning a structured failure.
 */

import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import assert from 'node:assert/strict'

const WS = '/tmp/dsh-duckdb-e2e-ws'
const OUTSIDE = '/tmp/dsh-duckdb-e2e-outside'

function setupWorkspace() {
  rmSync(WS, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
  mkdirSync(OUTSIDE, { recursive: true })
  writeFileSync(`${WS}/sales.csv`, 'city,amount\nHZ,100\nSH,200\nBJ,300\n')
  writeFileSync(`${OUTSIDE}/secret.csv`, 'id,name\n1,alice\n')
  // 5000-row parquet for the truncation test
  const rows = Array.from({ length: 5000 }, (_, i) => `(${i},${i * 2})`).join(',')
  writeFileSync(`${WS}/big.sql`, `COPY (SELECT * FROM (VALUES ${rows}) t(i,d)) TO '${WS}/big.parquet' (FORMAT PARQUET);\n`)
}

function runDuckdb(sql) {
  return execSync(`duckdb -c ${JSON.stringify(sql)}`, { encoding: 'utf8' })
}

/** Build the fake Cordis context the plugin expects. */
function makeCtx() {
  const registered = []
  const sections = []
  return {
    registered,
    sections,
    tools: {
      register: (definition) => {
        registered.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      section: (spec) => sections.push(spec),
    },
  }
}

/** Build the fake execution context a tool body receives. */
function makeExec(cwd = WS) {
  const controller = new AbortController()
  return {
    callId: 'e2e-call-1',
    name: 'e2e',
    arguments: {},
    rootCallId: 'e2e-call-1',
    token: Symbol('token'),
    signal: controller.signal,
    agent: {
      session: {
        header: { cwd },
      },
    },
    deferContext: () => {},
    concludeTurn: () => {},
  }
}

async function main() {
  setupWorkspace()
  runDuckdb(`.read ${WS}/big.sql`)

  const { apply, name, inject } = await import('/mnt/d/wsl2/dsh-duckdb/index.js')

  // --- 1. plugin contract ------------------------------------------------
  assert.equal(name, 'dsh-duckdb')
  assert.deepEqual(inject, ['tools', 'systemPrompt'])
  console.log('PASS plugin contract: name + inject')

  const ctx = makeCtx()
  apply(ctx)
  assert.equal(ctx.registered.length, 2, 'exactly two tools registered')
  assert.equal(ctx.sections.length, 1, 'one prompt section contributed')
  assert.equal(ctx.sections[0].name, 'tool:duckdb')
  const tools = Object.fromEntries(ctx.registered.map((t) => [t.name, t]))
  assert.ok(tools.duckdb_query, 'duckdb_query registered')
  assert.ok(tools.duckdb_schema, 'duckdb_schema registered')
  console.log('PASS registration: duckdb_query + duckdb_schema + prompt section')

  // --- 2. schema then query, the intended workflow ----------------------
  const schema = await tools.duckdb_schema.execute(
    { target: `${WS}/sales.csv` },
    makeExec(),
  )
  assert.equal(schema.ok, true)
  assert.deepEqual(schema.columns.map((c) => c.name), ['city', 'amount'])
  assert.equal(schema.row_count_approx, 3)
  assert.equal(schema.size_bytes > 0, true)
  console.log('PASS duckdb_schema: 2 columns, 3 rows, size reported')

  const agg = await tools.duckdb_query.execute(
    { sql: 'SELECT city, sum(amount) AS total FROM f0 GROUP BY city ORDER BY city', files: [`${WS}/sales.csv`] },
    makeExec(),
  )
  assert.equal(agg.ok, true)
  assert.deepEqual(agg.columns, ['city', 'total'])
  assert.deepEqual(agg.rows, [['BJ', 300], ['HZ', 100], ['SH', 200]])
  assert.equal(agg.truncated, false)
  assert.equal(agg.row_count, 3)
  console.log('PASS duckdb_query: aggregation values correct, not truncated')

  // --- 3. truncation is real -------------------------------------------
  const big = await tools.duckdb_query.execute(
    { sql: 'SELECT * FROM f0', files: [`${WS}/big.parquet`], max_rows: 10 },
    makeExec(),
  )
  assert.equal(big.ok, true)
  assert.equal(big.rows.length, 10)
  assert.equal(big.row_count, 5000)
  assert.equal(big.truncated, true)
  console.log('PASS truncation: 10 rows returned, row_count=5000, truncated=true')

  // --- 4. path escape is refused ---------------------------------------
  for (const [label, target] of [
    ['absolute outside', `${OUTSIDE}/secret.csv`],
    ['dotdot traversal', `${WS}/../dsh-duckdb-e2e-outside/secret.csv`],
    ['missing file', `${WS}/nope.csv`],
  ]) {
    const denied = await tools.duckdb_query.execute(
      { sql: 'SELECT count(*) AS n FROM f0', files: [target] },
      makeExec(),
    )
    assert.equal(denied.ok, false, label)
    assert.equal(denied.error.code !== undefined, true, `${label}: error.code present`)
    console.log(`PASS path refused (${label}): ${denied.error.code}`)
  }

  // --- 5. symlink escape is refused ------------------------------------
  symlinkSync(`${OUTSIDE}/secret.csv`, `${WS}/link.csv`)
  const sym = await tools.duckdb_query.execute(
    { sql: 'SELECT * FROM f0', files: [`${WS}/link.csv`] },
    makeExec(),
  )
  assert.equal(sym.ok, false)
  assert.equal(sym.error.code, 'SYMLINK_ESCAPE')
  console.log('PASS symlink escape refused: SYMLINK_ESCAPE')

  // --- 6. read-only guard blocks writes ---------------------------------
  const writes = [
    'CREATE TABLE zz AS SELECT 1',
    "COPY (SELECT 1) TO '/tmp/pwn.parquet' (FORMAT PARQUET)",
    'DROP TABLE IF EXISTS zz',
  ]
  for (const sql of writes) {
    const denied = await tools.duckdb_query.execute({ sql }, makeExec())
    assert.equal(denied.ok, false, sql)
    console.log(`PASS write refused (${sql.slice(0, 30)}...): ${denied.error.code}`)
  }
  const wrote = existsSync('/tmp/pwn.parquet')
  assert.equal(wrote, false, 'COPY must not have produced a file')
  console.log('PASS no file was written by the refused COPY')

  // --- 7. write mode is allowed when explicitly opted in -----------------
  const writeOk = await tools.duckdb_query.execute(
    { sql: 'CREATE TABLE zz AS SELECT 1 AS x', read_only: false },
    makeExec(),
  )
  assert.equal(writeOk.ok, true)
  console.log('PASS write allowed with read_only=false')

  // --- 8. statement batch refused --------------------------------------
  const batch = await tools.duckdb_query.execute(
    { sql: 'SELECT 1; SELECT 2' },
    makeExec(),
  )
  assert.equal(batch.ok, false)
  assert.equal(batch.error.code, 'MULTI_STATEMENT')
  console.log('PASS multi-statement refused')

  // --- 9. SQL error surfaces as structured failure ----------------------
  const bad = await tools.duckdb_query.execute(
    { sql: 'SELECT * FROM does_not_exist' },
    makeExec(),
  )
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'CLI_ERROR')
  console.log(`PASS SQL error surfaced: ${bad.error.code}`)

  // --- 10. render produces model-facing text ----------------------------
  const rendered = tools.duckdb_query.output.render({}, agg)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /BJ \| 300/)
  console.log('PASS render: model-facing text contains the values')

  console.log('\nALL 10 E2E CHECKS PASSED')
}

main().catch((error) => {
  console.error('E2E FAILED:', error)
  process.exit(1)
})
