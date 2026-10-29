import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coerceCell, numericRoundTrip } from '../lib/types.js'

test('HUGEINT cells are coerced to JSON numbers', () => {
  assert.equal(coerceCell('300', 'HUGEINT'), 300)
})

test('DECIMAL cells are coerced to JSON numbers', () => {
  assert.equal(coerceCell('1.50', 'DECIMAL'), 1.5)
})

test('a VARCHAR holding digits is NOT coerced', () => {
  // A zip code or phone number in a VARCHAR column must stay a string.
  assert.equal(coerceCell('300', 'VARCHAR'), '300')
})

test('DATE / TIMESTAMP / UUID strings are left alone', () => {
  assert.equal(coerceCell('2026-01-01', 'DATE'), '2026-01-01')
  assert.equal(coerceCell('11111111-2222-3333-4444-555555555555', 'UUID'), '11111111-2222-3333-4444-555555555555')
})

test('non-string cells pass through untouched', () => {
  assert.equal(coerceCell(300, 'HUGEINT'), 300)
  assert.equal(coerceCell(null, 'HUGEINT'), null)
  assert.equal(coerceCell(true, 'HUGEINT'), true)
})

test('a HUGEINT that is not numeric-shaped is left as a string', () => {
  assert.equal(coerceCell('N/A', 'HUGEINT'), 'N/A')
})

test('numericRoundTrip only accepts exact round-trips', () => {
  assert.equal(numericRoundTrip('300'), true)
  assert.equal(numericRoundTrip('1.50'), false)
  assert.equal(numericRoundTrip('abc'), false)
})
