import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildArgv, wrapStatement, readerFor, escapeSqlString, parseCliJson } from '../lib/cli.js'

test('wrapStatement creates one view per file in order', () => {
  const sql = wrapStatement('SELECT * FROM f0', ['/ws/a.csv', '/ws/b.parquet'], 10)
  assert.match(sql, /CREATE VIEW f0 AS SELECT \* FROM read_csv_auto\('\/ws\/a\.csv'\)/)
  assert.match(sql, /CREATE VIEW f1 AS SELECT \* FROM read_parquet\('\/ws\/b\.parquet'\)/)
  assert.match(sql, /LIMIT 10/)
  assert.match(sql, /__duckdb_total/)
})

test('wrapStatement with no files still applies the row limit', () => {
  const sql = wrapStatement('SELECT 1 AS a', [], 5)
  assert.match(sql, /SELECT \*, count\(\*\) OVER \(\) AS __duckdb_total FROM \(SELECT 1 AS a\) LIMIT 5/)
})

test('readerFor picks the reader by extension', () => {
  assert.match(readerFor('/a/x.parquet'), /^read_parquet/)
  assert.match(readerFor('/a/x.csv'), /^read_csv_auto/)
  assert.match(readerFor('/a/x.tsv'), /^read_csv_auto/)
  assert.match(readerFor('/a/x.json'), /^read_json_auto/)
  assert.match(readerFor('/a/x.jsonl'), /^read_json_auto/)
  assert.match(readerFor('/a/x.duckdb'), /^read_duckdb/)
  assert.match(readerFor('/a/x.unknown'), /^read_csv_auto/)
})

test('escapeSqlString doubles single quotes', () => {
  assert.equal(escapeSqlString("/a/b'c.csv"), "/a/b''c.csv")
})

test('buildArgv puts -unsigned before -json when requested', () => {
  const argv = buildArgv({ statement: 'SELECT 1', files: [], maxRows: 10, unsigned: true })
  assert.deepEqual(argv, ['-unsigned', '-json', '-c', wrapStatement('SELECT 1', [], 10)])
})

test('buildArgv omits -unsigned by default', () => {
  const argv = buildArgv({ statement: 'SELECT 1', files: [], maxRows: 10, unsigned: false })
  assert.equal(argv[0], '-json')
})

test('parseCliJson reads one pretty-printed array', () => {
  const text = '[\n{"a":1},\n{"a":2}\n]\n'
  const parsed = parseCliJson(text)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.arrays.length, 1)
  assert.deepEqual(parsed.arrays[0], [{ a: 1 }, { a: 2 }])
})

test('parseCliJson reads two arrays', () => {
  const text = '[{"a":1}]\n[{"b":2}]'
  const parsed = parseCliJson(text)
  assert.equal(parsed.arrays.length, 2)
})

test('parseCliJson reads an empty array', () => {
  const parsed = parseCliJson('[]')
  assert.deepEqual(parsed.arrays, [[]])
})

test('parseCliJson reads empty output', () => {
  assert.deepEqual(parseCliJson('').arrays, [])
})

test('parseCliJson survives brackets and quotes inside values', () => {
  const text = '[{"a":"x ]y \\"z["}]'
  const parsed = parseCliJson(text)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.arrays, [[{ a: 'x ]y "z[' }]])
})

test('parseCliJson reports unterminated arrays', () => {
  assert.equal(parseCliJson('[{"a":1}').ok, false)
})

test('parseCliJson reports non-array output', () => {
  assert.equal(parseCliJson('not json').ok, false)
})
