/**
 * Integration for the lake asset layer, against the REAL duckdb CLI.
 * Proves persistence across plugin calls (each = fresh CLI process).
 *
 * Run: DSH_DUCKDB_BIN=$HOME/duckdb200/duckdb node tests/integration-lake.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import process from 'node:process'

const bin = process.env.DSH_DUCKDB_BIN
if (!bin) { console.error('set DSH_DUCKDB_BIN'); process.exit(1) }

const { apply } = await import('../index.js')

const registered = []
const ctx = {
  tools: { register: (d) => { registered.push(d); return () => {} } },
  systemPrompt: { section: () => {} },
  jobs: undefined,
}
apply(ctx)
const tools = Object.fromEntries(registered.map((t) => [t.name, t]))

const ws = mkdtempSync(join(tmpdir(), 'dsh-lake-'))
const exec = () => ({ signal: new AbortController().signal, agent: { session: { header: { cwd: ws } } } })

try {
  // 1. lake_create
  const created = await tools.duckdb_lake_create.execute({ name: 'sales' }, exec())
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.fresh, true)
  assert.ok(existsSync(join(ws, 'lake-data', 'sales.ducklake')))
  console.log('✓ lake created:', created.path)

  // 2. idempotent reopen
  const reopened = await tools.duckdb_lake_create.execute({ name: 'sales' }, exec())
  assert.equal(reopened.ok, true)
  assert.equal(reopened.fresh, false, 'existing lake reopens, never wipes')
  console.log('✓ lake reopen is a no-op (fresh=false)')

  // 3. lake_write from csv
  writeFileSync(join(ws, 'sales.csv'), 'city,amount\nBJ,300\nSH,200\nHZ,100\n')
  const written = await tools.duckdb_lake_write.execute(
    { name: 'sales', table: 'daily', source: join(ws, 'sales.csv') }, exec())
  assert.equal(written.ok, true, JSON.stringify(written))
  console.log('✓ lake write: sales.ducklake::daily <- sales.csv')

  // 4. cross-call query through the lake prelude (fresh process!)
  const q = await tools.duckdb_query.execute(
    { sql: 'SELECT city, sum(amount) AS total FROM lake_sales.daily GROUP BY city ORDER BY total DESC' }, exec())
  assert.equal(q.ok, true, JSON.stringify(q))
  assert.equal(q.rows[0][0], 'BJ')
  assert.equal(Number(q.rows[0][1]), 300)
  assert.equal(q.rows.length, 3)
  console.log('✓ persistent query via lake_sales.daily:', JSON.stringify(q.rows))

  // 5. replace semantics
  writeFileSync(join(ws, 'sales2.csv'), 'city,amount\nBJ,999\n')
  const dup = await tools.duckdb_lake_write.execute(
    { name: 'sales', table: 'daily', source: join(ws, 'sales2.csv') }, exec())
  assert.equal(dup.ok, false)
  assert.equal(dup.error.code, 'TABLE_EXISTS', 'default refuses to clobber')
  const replaced = await tools.duckdb_lake_write.execute(
    { name: 'sales', table: 'daily', source: join(ws, 'sales2.csv'), replace: true }, exec())
  assert.equal(replaced.ok, true, JSON.stringify(replaced))
  const q2 = await tools.duckdb_query.execute(
    { sql: 'SELECT sum(amount) AS total FROM lake_sales.daily' }, exec())
  assert.equal(Number(q2.rows[0][0]), 999, 'replace actually replaced')
  console.log('✓ TABLE_EXISTS guard + explicit replace verified')

  // 6. escape: source outside the workspace
  const esc = await tools.duckdb_lake_write.execute(
    { name: 'sales', table: 'evil', source: '/etc/passwd' }, exec())
  assert.equal(esc.ok, false)
  assert.equal(esc.error.code, 'ESCAPE')
  console.log('✓ workspace escape rejected (ESCAPE)')

  // 7. catalog lists lakes
  const cat = await tools.duckdb_catalog.execute({}, exec())
  assert.equal(cat.ok, true)
  assert.equal(cat.lakes.length, 1)
  assert.equal(cat.lakes[0].name, 'sales')
  console.log('✓ duckdb_catalog lists lakes')

  console.log('\nALL LAKE INTEGRATION CHECKS PASSED')
} finally {
  rmSync(ws, { recursive: true, force: true })
}
