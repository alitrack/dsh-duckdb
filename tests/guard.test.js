import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkStatement, assertSingleStatement, statementKeywords } from '../lib/guard.js'

test('read-only mode accepts SELECT', () => {
  const v = checkStatement('SELECT * FROM f0', true)
  assert.equal(v.ok, true)
  assert.equal(v.kind, 'read')
})

test('read-only mode accepts WITH ... SELECT', () => {
  const v = checkStatement('WITH t AS (SELECT 1) SELECT * FROM t', true)
  assert.equal(v.ok, true)
})

test('read-only mode accepts DESCRIBE / SHOW / EXPLAIN / SUMMARIZE / PRAGMA', () => {
  for (const sql of ['DESCRIBE f0', 'SHOW TABLES', 'EXPLAIN SELECT 1', 'SUMMARIZE f0', 'PRAGMA version']) {
    assert.equal(checkStatement(sql, true).ok, true, sql)
  }
})

test('read-only mode rejects CREATE', () => {
  const v = checkStatement('CREATE TABLE zz AS SELECT 1', true)
  assert.equal(v.ok, false)
  assert.equal(v.code, 'NOT_READ_ONLY')
})

test('read-only mode rejects INSERT/UPDATE/DELETE/DROP/ALTER', () => {
  for (const sql of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a=1', 'DELETE FROM t', 'DROP TABLE t', 'ALTER TABLE t ADD COLUMN c INT']) {
    assert.equal(checkStatement(sql, true).ok, false, sql)
  }
})

test('COPY is always blocked, even with read_only false', () => {
  const v = checkStatement("COPY (SELECT 1) TO '/tmp/x.parquet' (FORMAT PARQUET)", false)
  assert.equal(v.ok, false)
  assert.equal(v.code, 'BLOCKED_KEYWORD')
})

test('ATTACH / INSTALL / LOAD / SET are always blocked', () => {
  for (const sql of ["ATTACH '/tmp/x.db' AS x", 'INSTALL httpfs', 'LOAD luajit', 'SET threads=4']) {
    const v = checkStatement(sql, false)
    assert.equal(v.ok, false, sql)
    assert.equal(v.code, 'BLOCKED_KEYWORD')
  }
})

test('write mode allows CREATE when read_only is false', () => {
  const v = checkStatement('CREATE TABLE zz AS SELECT 1', false)
  assert.equal(v.ok, true)
  assert.equal(v.kind, 'write')
})

test('a keyword inside a string literal does not trigger the guard', () => {
  // The literal contains the word COPY; the statement itself is a SELECT.
  const v = checkStatement("SELECT 'please COPY this file' AS note", true)
  assert.equal(v.ok, true)
})

test('a keyword inside a comment does not trigger the guard', () => {
  const v = checkStatement('-- COPY (SELECT 1) TO x\nSELECT 1', true)
  assert.equal(v.ok, true)
})

test('single statement check rejects a trailing second statement', () => {
  const v = assertSingleStatement('SELECT 1; DROP TABLE t')
  assert.equal(v.ok, false)
  assert.equal(v.code, 'MULTI_STATEMENT')
})

test('single statement check tolerates one trailing semicolon', () => {
  const v = assertSingleStatement('SELECT 1;')
  assert.equal(v.ok, true)
  assert.equal(v.sql, 'SELECT 1')
})

test('single statement check tolerates a semicolon inside a literal', () => {
  const v = assertSingleStatement("SELECT 'a;b' AS s")
  assert.equal(v.ok, true)
})

test('empty statement is rejected', () => {
  assert.equal(assertSingleStatement('   ').code, 'EMPTY_SQL')
  assert.equal(checkStatement('   ', true).code, 'EMPTY_SQL')
})

test('statementKeywords ignores comments and literals', () => {
  const words = statementKeywords("SELECT 'CREATE TABLE x' AS a -- DROP\n")
  assert.deepEqual(words, ['SELECT', 'AS', 'A'])
})
