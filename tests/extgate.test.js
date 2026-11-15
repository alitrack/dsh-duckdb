import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveGate, extensionAllowed, describeGate, ALLOW_EXTENSIONS_ENV, ALLOW_REMOTE_ENV } from '../lib/extgate.js'
import { checkRemoteAccess, checkLoadStatement, stringLiterals } from '../lib/guard.js'

// ---- resolveGate ----

test('resolveGate: defaults are fail-closed', () => {
  const g = resolveGate({})
  assert.deepEqual(g.allowExtensions, [])
  assert.equal(g.allowRemote, false)
})

test('resolveGate: parses comma lists, dedupes, lowercases', () => {
  const g = resolveGate({ [ALLOW_EXTENSIONS_ENV]: 'httpfs, Excel, httpfs' })
  assert.deepEqual(g.allowExtensions, ['httpfs', 'excel'])
})

test('resolveGate: none/all tokens', () => {
  assert.deepEqual(resolveGate({ [ALLOW_EXTENSIONS_ENV]: 'none' }).allowExtensions, [])
  assert.equal(resolveGate({ [ALLOW_EXTENSIONS_ENV]: 'all' }).allowExtensions, 'all')
  const weird = resolveGate({ [ALLOW_EXTENSIONS_ENV]: 'httpfs, has space!, ok' })
  assert.deepEqual(weird.unknownTokens, ['has space!'])
})

test('resolveGate: remote flag', () => {
  assert.equal(resolveGate({ [ALLOW_REMOTE_ENV]: '1' }).allowRemote, true)
  assert.equal(resolveGate({ [ALLOW_REMOTE_ENV]: 'true' }).allowRemote, true)
  assert.equal(resolveGate({ [ALLOW_REMOTE_ENV]: '0' }).allowRemote, false)
  assert.equal(resolveGate({ [ALLOW_REMOTE_ENV]: 'yes' }).allowRemote, false)
})

test('extensionAllowed respects list and all', () => {
  const list = resolveGate({ [ALLOW_EXTENSIONS_ENV]: 'httpfs' })
  assert.equal(extensionAllowed('httpfs', list), true)
  assert.equal(extensionAllowed('HTTPFS', list), true)
  assert.equal(extensionAllowed('aws', list), false)
  const all = resolveGate({ [ALLOW_EXTENSIONS_ENV]: 'all' })
  assert.equal(extensionAllowed('anything', all), true)
})

test('describeGate names the three states', () => {
  assert.match(describeGate(resolveGate({})), /closed/)
  assert.match(describeGate(resolveGate({ [ALLOW_EXTENSIONS_ENV]: 'httpfs' })), /httpfs/)
  assert.match(describeGate(resolveGate({ [ALLOW_EXTENSIONS_ENV]: 'all' })), /ALL/)
})

// ---- checkRemoteAccess ----

test('remote URLs blocked when off, allowed when on', () => {
  const sql = "SELECT * FROM read_parquet('https://x/y.parquet')"
  assert.equal(checkRemoteAccess(sql, false).code, 'REMOTE_BLOCKED')
  assert.equal(checkRemoteAccess(sql, true).ok, true)
})

test('all remote prefixes are covered, local paths pass', () => {
  for (const p of ['http://', 'https://', 's3://', 's3a://', 'gcs://', 'gs://', 'r2://', 'az://', 'azure://', 'oci://', 'hf://']) {
    const verdict = checkRemoteAccess(`SELECT * FROM read_parquet('${p}bucket/f')`, false)
    assert.equal(verdict.code, 'REMOTE_BLOCKED', `${p} must be blocked`)
  }
  assert.equal(checkRemoteAccess("SELECT * FROM read_parquet('/ws/f.parquet')", false).ok, true)
})

test('URLs hidden in comments or doubled quotes are still caught (comments stripped first)', () => {
  // a URL inside a comment does not count as access
  assert.equal(checkRemoteAccess("SELECT 1 -- see https://example.com\n", false).ok, true)
  // escaped quote inside literal keeps the URL intact
  const verdict = checkRemoteAccess("SELECT * FROM read_parquet('https://a/b''c.parquet')", false)
  assert.equal(verdict.code, 'REMOTE_BLOCKED')
})

// ---- checkLoadStatement ----

test('LOAD only allowed as a bare statement for allowed names', () => {
  const allow = (n) => n === 'httpfs'
  assert.equal(checkLoadStatement('LOAD httpfs', allow).ok, true)
  assert.equal(checkLoadStatement('load httpfs;', allow).ok, true)
  assert.equal(checkLoadStatement('LOAD aws', allow).code, 'EXTENSION_NOT_ALLOWED')
  assert.equal(checkLoadStatement("LOAD '/tmp/evil.so'", allow).ok, false)
  assert.equal(checkLoadStatement('LOAD httpfs; DROP TABLE x', allow).ok, false)
})

test('stringLiterals extracts literals and skips comments', () => {
  const lits = stringLiterals("SELECT 'a', 'b''c' -- no 'd'\n/* 'e' */ FROM t")
  assert.deepEqual(lits, ['a', "b'c"])
})
