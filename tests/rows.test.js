import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampMaxRows, projectRows, TOTAL_COLUMN, MAX_ROWS_HARD_CAP } from '../lib/rows.js'

test('default max_rows is 200', () => {
  assert.equal(clampMaxRows(undefined), 200)
  assert.equal(clampMaxRows(null), 200)
})

test('hard cap is 1000', () => {
  assert.equal(clampMaxRows(999999), MAX_ROWS_HARD_CAP)
  assert.equal(MAX_ROWS_HARD_CAP, 1000)
})

test('non-positive and garbage requests fall back to the default', () => {
  assert.equal(clampMaxRows(0), 200)
  assert.equal(clampMaxRows(-5), 200)
  assert.equal(clampMaxRows('abc'), 200)
  assert.equal(clampMaxRows(1.9), 1)
})

test('valid request passes through', () => {
  assert.equal(clampMaxRows(50), 50)
})

test('projectRows strips the injected total column', () => {
  const rows = [
    { a: 1, [TOTAL_COLUMN]: 5000 },
    { a: 2, [TOTAL_COLUMN]: 5000 },
  ]
  const out = projectRows(rows)
  assert.deepEqual(out.columns, ['a'])
  assert.deepEqual(out.rows, [[1], [2]])
  assert.equal(out.row_count, 5000)
  assert.equal(out.truncated, true)
})

test('projectRows reports not-truncated when the total equals the row count', () => {
  const rows = [{ a: 1, [TOTAL_COLUMN]: 2 }, { a: 2, [TOTAL_COLUMN]: 2 }]
  const out = projectRows(rows)
  assert.equal(out.truncated, false)
  assert.equal(out.row_count, 2)
})

test('projectRows handles an empty result', () => {
  const out = projectRows([])
  assert.deepEqual(out.columns, [])
  assert.deepEqual(out.rows, [])
  assert.equal(out.row_count, 0)
  assert.equal(out.truncated, false)
})

test('projectRows handles a result with no injected column', () => {
  const out = projectRows([{ a: 1 }])
  assert.deepEqual(out.columns, ['a'])
  assert.equal(out.row_count, 1)
  assert.equal(out.truncated, false)
})
