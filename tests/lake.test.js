import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Catalog } from '../lib/catalog.js'
import { validateLakeName, validateTableName, lakePath, lakePrelude } from '../lib/lake.js'

test('lake name/table validation', () => {
  assert.equal(validateLakeName('sales').ok, true)
  assert.equal(validateLakeName('Sales').ok, false)
  assert.equal(validateLakeName('1x').ok, false)
  assert.equal(validateLakeName('').ok, false)
  assert.equal(validateTableName('daily_totals').ok, true)
  assert.equal(validateTableName('x'.repeat(65)).ok, false)
})

test('lakePath stays inside the workspace lake-data dir', () => {
  const root = '/ws'
  assert.equal(lakePath(root, 'sales'), '/ws/lake-data/sales.ducklake')
})

test('catalog.registerLake / listLakes: per-workspace visibility', () => {
  const cat = new Catalog()
  cat.registerLake('sales', '/ws-a')
  cat.registerLake('sales', '/ws-b')
  cat.registerLake('metrics', '/ws-a')
  const a = cat.listLakes('/ws-a').map((l) => l.name).sort()
  assert.deepEqual(a, ['metrics', 'sales'])
  const b = cat.listLakes('/ws-b').map((l) => l.name)
  assert.deepEqual(b, ['sales'])
  // idempotent: no duplicates on re-register
  cat.registerLake('sales', '/ws-a')
  assert.equal(cat.listLakes('/ws-a').filter((l) => l.name === 'sales').length, 1)
})

test('lakePrelude emits one ATTACH per registered lake', () => {
  const cat = new Catalog()
  cat.registerLake('sales', '/ws-a')
  const lines = lakePrelude(cat, '/ws-a')
  assert.deepEqual(lines, ["ATTACH '/ws-a/lake-data/sales.ducklake' AS lake_sales (TYPE DUCKLAKE)"])
  assert.deepEqual(lakePrelude(cat, '/ws-b'), [], 'other workspace lakes are invisible')
})

// lakeCreate/lakeWrite hit the real CLI and are exercised in integration.
test('lakeCreate rejects bad names before touching the fs', async () => {
  const { lakeCreate } = await import('../lib/lake.js')
  const bad = await lakeCreate({ root: '/ws', name: 'BAD!', binary: '/nonexistent' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'BAD_LAKE_NAME')
})

test('lakeWrite requires an existing lake', async () => {
  const { lakeWrite } = await import('../lib/lake.js')
  const ws = mkdtempSync(join(tmpdir(), 'lake-'))
  try {
    writeFileSync(join(ws, 'a.csv'), 'x\n1\n')
    const r = await lakeWrite({ root: ws, name: 'ghost', table: 't', source: join(ws, 'a.csv') })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'NO_LAKE')
    assert.ok(!existsSync(join(ws, 'lake-data')))
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
