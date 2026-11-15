/**
 * L3.5-style integration: drive the plugin's exported tools against a fake
 * Cordis ctx and the REAL duckdb CLI (2.0.0 stable), covering the three new
 * tools plus the alias path in duckdb_query.
 *
 * Run: DSH_DUCKDB_BIN=$HOME/duckdb200/duckdb node tests/integration-v02.mjs
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import process from 'node:process'

const bin = process.env.DSH_DUCKDB_BIN
if (!bin) {
  console.error('set DSH_DUCKDB_BIN to a duckdb binary (e.g. ~/duckdb200/duckdb)')
  process.exit(1)
}

const { apply } = await import('../index.js')

const registered = []
const sections = []
const ctx = {
  tools: { register: (d) => { registered.push(d); return () => {} } },
  systemPrompt: { section: (s) => { sections.push(s) } },
}
apply(ctx)
const tools = Object.fromEntries(registered.map((t) => [t.name, t]))
assert.deepEqual(Object.keys(tools).sort(),
  ['duckdb_attach', 'duckdb_catalog', 'duckdb_convert', 'duckdb_extensions', 'duckdb_query', 'duckdb_schema'])
console.log('✓ 5 tools registered:', Object.keys(tools).sort().join(', '))

const ws = mkdtempSync(join(tmpdir(), 'dsh-duckdb-int-'))
const exec = () => ({
  signal: new AbortController().signal,
  agent: { session: { header: { cwd: ws } } },
})

try {
  writeFileSync(join(ws, 'sales.csv'), 'city,amount\nBJ,300\nSH,200\nHZ,100\n')
  writeFileSync(join(ws, 'other.csv'), 'city,amount\nBJ,1\nSH,2\n')

  // 1. attach + catalog
  const att = await tools.duckdb_attach.execute({ alias: 'sales', files: [join(ws, 'sales.csv')] }, exec())
  assert.equal(att.ok, true)
  assert.equal(att.file_count, 1)
  const cat = await tools.duckdb_catalog.execute({}, exec())
  assert.equal(cat.attachments.length, 1)
  assert.equal(cat.attachments[0].alias, 'sales')
  console.log('✓ duckdb_attach + duckdb_catalog work')

  // 2. query via alias (metadata persistence, not view persistence)
  const q = await tools.duckdb_query.execute({ sql: 'SELECT city, sum(amount) AS total FROM f0 GROUP BY city ORDER BY city', alias: 'sales' }, exec())
  assert.equal(q.ok, true)
  assert.deepEqual(q.rows, [['BJ', 300], ['HZ', 100], ['SH', 200]])
  console.log('✓ duckdb_query via alias returns exact aggregates')

  // 3. cross-file JOIN: files + alias merged
  const j = await tools.duckdb_query.execute({
    sql: 'SELECT count(*) AS n FROM f0 JOIN f1 USING (city)',
    files: [join(ws, 'other.csv')], alias: 'sales',
  }, exec())
  assert.equal(j.ok, true, JSON.stringify(j))
  assert.equal(j.rows[0][0], 2)
  console.log('✓ files+alias merge → cross-file JOIN')

  // 4. unknown alias fails with structured error
  const bad = await tools.duckdb_query.execute({ sql: 'SELECT 1', alias: 'nope' }, exec())
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'UNKNOWN_ALIAS')
  console.log('✓ unknown alias → UNKNOWN_ALIAS')

  // 5. convert csv → parquet (real COPY) + read-back roundtrip
  const cv = await tools.duckdb_convert.execute({ input: join(ws, 'sales.csv'), output: join(ws, 'out.parquet'), output_format: 'parquet' }, exec())
  assert.equal(cv.ok, true, JSON.stringify(cv))
  assert.ok(existsSync(join(ws, 'out.parquet')))
  const buf = readFileSync(join(ws, 'out.parquet'))
  assert.equal(buf.subarray(0, 4).toString(), 'PAR1', 'parquet magic')
  const rb = await tools.duckdb_query.execute({ sql: 'SELECT count(*) AS n, sum(amount) AS s FROM f0', files: [join(ws, 'out.parquet')] }, exec())
  assert.equal(rb.rows[0][0], 3)
  assert.equal(rb.rows[0][1], 600)
  console.log('✓ duckdb_convert csv→parquet + roundtrip read (3 rows, sum 600)')

  // 6. convert escape attempts
  const out1 = await tools.duckdb_convert.execute({ input: join(ws, 'sales.csv'), output: '/tmp/evil.parquet', output_format: 'parquet' }, exec())
  assert.equal(out1.ok, false)
  const out2 = await tools.duckdb_convert.execute({ input: join(ws, 'sales.csv'), output: join(ws, 'x.bin'), output_format: 'parquet' }, exec())
  assert.equal(out2.ok, false)
  assert.equal(out2.error.code, 'BAD_OUTPUT')
  console.log('✓ convert rejects outside-workspace output and extension mismatch')

  // 7. guard still blocks COPY inside duckdb_query
  const smuggle = await tools.duckdb_query.execute({ sql: `COPY (SELECT 1) TO '${join(ws, 'smuggled.parquet')}' (FORMAT parquet)` }, exec())
  assert.equal(smuggle.ok, false)
  assert.ok(!existsSync(join(ws, 'smuggled.parquet')), 'no file may appear')
  console.log('✓ COPY via duckdb_query still blocked, no file written')

  // 8. HUGEINT roundtrip still works on 2.0.0 stable
  const h = await tools.duckdb_query.execute({ sql: 'SELECT sum(amount) AS s FROM f0', files: [join(ws, 'sales.csv')] }, exec())
  assert.equal(h.rows[0][0], 600)
  assert.equal(typeof h.rows[0][0], 'number', 'HUGEINT must come back as a JSON number')
  console.log('✓ HUGEINT numeric roundtrip on duckdb 2.0.0 stable')

  console.log('\nALL INTEGRATION CHECKS PASSED')
} finally {
  rmSync(ws, { recursive: true, force: true })
}
