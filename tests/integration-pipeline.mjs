/**
 * Integration: duckdb_pipeline against the REAL @deepseek-ai/dsh-jobs-local
 * registry (ctx.jobs), exercising the full chain: tool execute → job start →
 * steps run → settle → registry read.
 *
 * Run: DSH_DUCKDB_BIN=$HOME/duckdb200/duckdb node tests/integration-pipeline.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import process from 'node:process'

const bin = process.env.DSH_DUCKDB_BIN
if (!bin) { console.error('set DSH_DUCKDB_BIN'); process.exit(1) }

const jobsLocalModule = await import('/home/lhy/.npm/_npx/50d2c97abf8f4186/node_modules/@deepseek-ai/dsh-jobs-local/lib/index.js')
const LocalJobRegistry = jobsLocalModule.LocalJobRegistry ?? jobsLocalModule.default
const cordis = await import('/home/lhy/.npm/_npx/50d2c97abf8f4186/node_modules/@deepseek-ai/cordis/lib/index.js')
const { apply } = await import('../index.js')

// A real Cordis Context — LocalJobRegistry is a Cordis Service and needs
// ctx.reflect/provide, events, and effect wiring, not a plain object.
const cordisCtx = new cordis.Context()
const registered = []
let jobsService = null
const ctx = cordisCtx
ctx.tools = { register: (d) => { registered.push(d); return () => {} } }
ctx.systemPrompt = { section: () => {} }
jobsService = new LocalJobRegistry(ctx, {
  maxConcurrentJobsPerOwner: 10,
  retainBytes: 262144,
  settledRetainBytes: 16384,
  pumpPollMs: 150,
})
ctx.jobs = jobsService
// The controller that admits starts (normally mounted by dsh-tool-jobs).
ctx.jobs.attachController('tool-jobs')
assert.equal(typeof jobsService?.start, 'function', 'dsh-jobs-local should have attached ctx.jobs')
console.log('✓ real dsh-jobs-local registry attached (ctx.jobs.start)')

apply(ctx)
const tools = Object.fromEntries(registered.map((t) => [t.name, t]))
assert.equal('duckdb_pipeline' in tools, true)
console.log('✓ duckdb_pipeline registered:', 'duckdb_pipeline' in tools)

const ws = mkdtempSync(join(tmpdir(), 'dsh-pipe-'))
const exec = () => ({ signal: new AbortController().signal, agent: { session: { header: { cwd: ws } } } })

try {
  writeFileSync(join(ws, 'sales.csv'), 'city,amount\nBJ,300\nSH,200\nHZ,100\n')

  // 1. happy path: 3-step pipeline, real background execution
  const started = await tools.duckdb_pipeline.execute({
    label: 'daily sales rollup',
    steps: [
      { sql: 'SELECT city, sum(amount) AS total FROM f0 GROUP BY city', files: [join(ws, 'sales.csv')], label: 'rollup' },
      { sql: 'SELECT 42 AS checkpoint' },
      { sql: 'SELECT count(*) AS n FROM range(1000) t(i)' },
    ],
  }, exec())
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.match(started.job_id, /^duckdb-/)
  console.log(`✓ pipeline started: ${started.job_id} (${started.step_count} steps)`)

  await jobsService.wait(started.job_id, 60_000, undefined)
  const read = jobsService.read(started.job_id, undefined)
  // result is handed to the FIRST read after settlement only; chunks carry
  // the same per-step data, so parse from the ring if result was consumed.
  const resultText = read.result ?? read.chunks.map((c) => c.text).join('')
  const results = [...resultText.matchAll(/"ok":\s*(true|false)/g)].map((m) => m[1] === 'true')
  assert.equal(read.job.status, 'succeeded')
  assert.equal(read.chunks.length, 3, 'one ring chunk per step')
  assert.ok(results.every((ok) => ok), 'every step succeeded')
  console.log('✓ 3 steps settled succeeded; ring captured', read.chunks.length, 'chunks')

  // 2. fail-fast: step 2 guard violation stops the chain
  const bad = await tools.duckdb_pipeline.execute({
    steps: [
      { sql: 'SELECT 1 AS a' },
      { sql: "COPY (SELECT 1) TO '/tmp/evil.parquet'" },
      { sql: 'SELECT 3' },
    ],
  }, exec())
  assert.equal(bad.ok, true)
  await jobsService.wait(bad.job_id, 30_000, undefined)
  const badRead = jobsService.read(bad.job_id, undefined)
  assert.equal(badRead.job.status, 'failed')
  const badText = badRead.result ?? badRead.chunks.map((c) => c.text).join('')
  assert.match(badText, /"ok":false/)
  assert.equal(badRead.chunks.length, 2, 'third step must not run (2 ring chunks)')
  assert.ok(!existsSync('/tmp/evil.parquet'), 'no file may appear')
  console.log('✓ guard failure at step 2 halts pipeline; no file written')

  // 3. bad path fails before job start (workspace escape in files)
  const esc = await tools.duckdb_pipeline.execute({
    steps: [{ sql: 'SELECT 1', files: ['/etc/passwd'] }],
  }, exec())
  assert.equal(esc.ok, false)
  assert.equal(esc.error.code, 'ESCAPE')
  console.log('✓ workspace-escape file rejected before job start (ESCAPE)')

  console.log('\nALL PIPELINE INTEGRATION CHECKS PASSED')
} finally {
  rmSync(ws, { recursive: true, force: true })
}
