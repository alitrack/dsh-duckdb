import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePipeline, pipelineJobSpec, STEP_TIMEOUT_MS } from '../lib/pipeline.js'

test('validatePipeline: shape, caps, defaults', () => {
  assert.equal(validatePipeline(null).code, 'BAD_PIPELINE')
  assert.equal(validatePipeline({ steps: [] }).code, 'BAD_PIPELINE')
  assert.equal(validatePipeline({ steps: Array.from({ length: 21 }, () => ({ sql: 'SELECT 1' })) }).code, 'BAD_PIPELINE')
  assert.equal(validatePipeline({ steps: [{ sql: '  ' }] }).code, 'BAD_PIPELINE')

  const ok = validatePipeline({ steps: [{ sql: 'SELECT 1', read_only: false, label: 'x'.repeat(200) }] })
  assert.equal(ok.ok, true)
  assert.equal(ok.steps[0].read_only, false)
  assert.equal(ok.steps[0].label.length, 80, 'labels clamp at 80 chars')
  assert.equal(validatePipeline({ steps: [{ sql: 'SELECT 1' }] }).steps[0].label, 'step 1', 'default label')
})

test('pipelineJobSpec: happy path reports per-step results', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pipe-'))
  try {
    writeFileSync(join(ws, 'a.csv'), 'x\n1\n2\n')
    const { steps } = validatePipeline({
      steps: [
        { sql: 'SELECT count(*) AS n FROM f0', files: [join(ws, 'a.csv')], label: 'count' },
        { sql: 'SELECT 42 AS ok' },
      ],
    })
    steps[0].resolvedFiles = [join(ws, 'a.csv')]
    steps[1].resolvedFiles = []

    const spec = pipelineJobSpec({
      steps,
      label: 'test pipeline',
      extensionPrelude: async () => [],
      resolveFiles: () => ({ ok: true }),
      root: ws,
    })
    assert.equal(spec.kind, 'duckdb')
    assert.equal(spec.label, 'test pipeline')
    assert.equal(spec.outputLimitBytes, 32_768)

    const appended = []
    const progress = []
    const hooks = spec.run({ id: 'duckdb-test', append: (t) => appended.push(t), updateProgress: (l) => progress.push(l) })
    const outcome = await hooks.done
    assert.equal(outcome.status, 'completed')
    const result = JSON.parse(outcome.result)
    assert.equal(result.ok, true)
    assert.equal(result.steps, 2)
    assert.equal(result.results[0].ok, true)
    assert.equal(result.results[0].rows_sampled, 1)
    assert.match(progress.at(-1), /^2\/2/)
    assert.equal(appended.length, 2)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('pipelineJobSpec: guard failure stops the chain with a failed outcome', async () => {
  const { steps } = validatePipeline({
    steps: [
      { sql: 'SELECT 1 AS ok' },
      { sql: "COPY (SELECT 1) TO '/tmp/evil.parquet'" }, // guard blocks COPY
      { sql: 'SELECT 2' },
    ],
  })
  for (const s of steps) s.resolvedFiles = []
  const spec = pipelineJobSpec({
    steps, label: 'evil', extensionPrelude: async () => [], resolveFiles: () => ({ ok: true }), root: '/tmp',
  })
  const hooks = spec.run({ id: 'duckdb-x', append: () => {}, updateProgress: () => {} })
  const outcome = await hooks.done
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /step 2/)
  const result = JSON.parse(outcome.result)
  assert.equal(result.steps, 2, 'third step never ran')
})

test('pipelineJobSpec: cancel() halts before the next step', async () => {
  const { steps } = validatePipeline({ steps: [{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }, { sql: 'SELECT 3' }] })
  for (const s of steps) s.resolvedFiles = []
  let cancelledFlag = false
  const spec = pipelineJobSpec({
    steps, label: 'cancel-test',
    extensionPrelude: async () => [],
    resolveFiles: () => ({ ok: true }), root: '/tmp',
  })
  // cancel after the first step completes: emulate by cancelling inside run
  const hooks = spec.run({
    id: 'duckdb-c',
    append: () => {},
    updateProgress: () => { if (!cancelledFlag) { cancelledFlag = true; hooks.cancel() } },
  })
  const outcome = await hooks.done
  assert.equal(outcome.status, 'killed')
})

test('STEP_TIMEOUT_MS is generous for pipelines', () => {
  assert.ok(STEP_TIMEOUT_MS >= 60_000)
})
