import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wrapStatement, isQueryStatement } from '../lib/cli.js'

test('a query is wrapped with the row-limit projection', () => {
  const sql = wrapStatement('SELECT * FROM f0', ['/ws/a.csv'], 10)
  assert.match(sql, /SELECT \*, count\(\*\) OVER \(\) AS __duckdb_total FROM \(SELECT \* FROM f0\) LIMIT 10/)
})

test('a DDL statement runs verbatim, not wrapped', () => {
  // Wrapping a DDL in a SELECT wrapper is a parser error (verified on
  // duckdb v2.0.0-alpha39998): `SELECT * FROM (CREATE TABLE ...)`.
  const sql = wrapStatement('CREATE TABLE zz AS SELECT 1 AS x', [], 10)
  assert.match(sql, /^CREATE TABLE zz AS SELECT 1 AS x$/)
  assert.doesNotMatch(sql, /__duckdb_total/)
})

test('DML statements run verbatim too', () => {
  for (const statement of [
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'DROP TABLE t',
  ]) {
    assert.match(wrapStatement(statement, [], 5), new RegExp(`^${statement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  }
})

test('isQueryStatement classifies leaders', () => {
  assert.equal(isQueryStatement('SELECT 1'), true)
  assert.equal(isQueryStatement('WITH t AS (SELECT 1) SELECT * FROM t'), true)
  assert.equal(isQueryStatement('DESCRIBE f0'), true)
  assert.equal(isQueryStatement('SHOW TABLES'), true)
  assert.equal(isQueryStatement('CREATE TABLE t AS SELECT 1'), false)
  assert.equal(isQueryStatement('INSERT INTO t VALUES (1)'), false)
  assert.equal(isQueryStatement('   '), false)
})

test('the view prelude is always emitted, wrapped or not', () => {
  const sql = wrapStatement('CREATE TABLE zz AS SELECT 1', ['/ws/a.csv'], 5)
  assert.match(sql, /CREATE VIEW f0 AS SELECT \* FROM read_csv_auto/)
  assert.match(sql, /CREATE TABLE zz AS SELECT 1$/)
})
