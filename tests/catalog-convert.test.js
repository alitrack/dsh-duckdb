import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Catalog, ALIAS_RE, MAX_FILES_PER_ALIAS } from '../lib/catalog.js'
import { validateConversion, buildConvertStatement, FORMATS } from '../lib/convert.js'

function makeWs() {
  const ws = mkdtempSync(join(tmpdir(), 'dsh-duckdb-v02-'))
  writeFileSync(join(ws, 'a.csv'), 'city,amount\nBJ,300\n')
  writeFileSync(join(ws, 'b.csv'), 'city,amount\nSH,200\n')
  mkdirSync(join(ws, 'data'))
  writeFileSync(join(ws, 'data', 'c.parquet'), 'fake')
  return ws
}

test('ALIAS_RE accepts lowercase identifiers and rejects the rest', () => {
  assert.ok(ALIAS_RE.test('sales'))
  assert.ok(ALIAS_RE.test('a9_x'))
  assert.ok(!ALIAS_RE.test('Sales'))
  assert.ok(!ALIAS_RE.test('9sales'))
  assert.ok(!ALIAS_RE.test('with-dash'))
  assert.ok(!ALIAS_RE.test('with space'))
  assert.ok(!ALIAS_RE.test('main.t'))
  assert.ok(!ALIAS_RE.test(''))
})

test('Catalog.attach registers exact files and rejects duplicates', () => {
  const ws = makeWs()
  try {
    const cat = new Catalog()
    const ok = cat.attach([join(ws, 'a.csv')], 'sales', ws)
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.files, [join(ws, 'a.csv')])

    const dup = cat.attach([join(ws, 'b.csv')], 'sales', ws)
    assert.equal(dup.ok, false)
    assert.equal(dup.code, 'ALIAS_TAKEN')

    assert.equal(cat.attach([], 'empty', ws).code, 'BAD_FILES')
    assert.equal(cat.attach([join(ws, 'a.csv')], 'Bad', ws).code, 'BAD_ALIAS')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('Catalog.attach expands globs in sorted order and validates every hit', () => {
  const ws = makeWs()
  try {
    const cat = new Catalog()
    const ok = cat.attach([join(ws, '*.csv')], 'csvs', ws)
    assert.equal(ok.ok, true)
    assert.equal(ok.files.length, 2)
    assert.ok(ok.files[0].endsWith('a.csv'))
    assert.ok(ok.files[1].endsWith('b.csv'))

    // a glob that escapes the workspace via .. must fail validation
    const escape = cat.attach([join(ws, '..', '*.csv')], 'esc', ws)
    assert.equal(escape.ok, false)

    assert.equal(cat.attach([join(ws, '*.zzz')], 'none', ws).code, 'GLOB_NO_MATCH')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('Catalog.resolve is workspace-scoped', () => {
  const ws = makeWs()
  const other = makeWs()
  try {
    const cat = new Catalog()
    cat.attach([join(ws, 'a.csv')], 'sales', ws)
    assert.equal(cat.resolve('sales', ws).ok, true)
    const cross = cat.resolve('sales', other)
    assert.equal(cross.ok, false)
    assert.equal(cross.code, 'UNKNOWN_ALIAS')
  } finally {
    rmSync(ws, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

test('Catalog.list only shows the calling workspace', () => {
  const ws = makeWs()
  const other = makeWs()
  try {
    const cat = new Catalog()
    cat.attach([join(ws, 'a.csv')], 'sales', ws)
    cat.attach([join(other, 'b.csv')], 'other', other)
    const mine = cat.list(ws)
    assert.equal(mine.length, 1)
    assert.equal(mine[0].alias, 'sales')
    assert.equal(mine[0].file_count, 1)
  } finally {
    rmSync(ws, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

test('MAX_FILES_PER_ALIAS is a sane bound', () => {
  assert.ok(MAX_FILES_PER_ALIAS >= 8 && MAX_FILES_PER_ALIAS <= 256)
})

// ---- convert ----

test('validateConversion accepts a fresh in-workspace output', () => {
  const ws = makeWs()
  try {
    const v = validateConversion(join(ws, 'a.csv'), join(ws, 'out.parquet'), 'parquet', ws)
    assert.equal(v.ok, true)
    assert.equal(v.output, join(ws, 'out.parquet'))
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('validateConversion rejects bad format, extension mismatch, escapes, same path', () => {
  const ws = makeWs()
  try {
    assert.equal(validateConversion(join(ws, 'a.csv'), join(ws, 'out.parquet'), 'xlsx', ws).code, 'BAD_FORMAT')
    assert.equal(validateConversion(join(ws, 'a.csv'), join(ws, 'out.csv'), 'parquet', ws).code, 'BAD_OUTPUT')
    // input outside workspace
    assert.equal(validateConversion('/etc/hostname', join(ws, 'out.parquet'), 'parquet', ws).ok, false)
    // output outside workspace (parent dir outside)
    assert.equal(validateConversion(join(ws, 'a.csv'), '/tmp/out.parquet', 'parquet', ws).ok, false)
    // output parent does not exist
    assert.equal(validateConversion(join(ws, 'a.csv'), join(ws, 'nope', 'out.parquet'), 'parquet', ws).ok, false)
    // same path
    assert.equal(validateConversion(join(ws, 'a.csv'), join(ws, 'a.csv'), 'csv', ws).code, 'SAME_PATH')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('buildConvertStatement quotes paths and pins the format', () => {
  const stmt = buildConvertStatement("/ws/a'b.csv", '/ws/out.parquet', 'parquet')
  assert.ok(stmt.startsWith("COPY (SELECT * FROM read_csv_auto('"))
  assert.match(stmt, /a''b\.csv/)
  assert.match(stmt, /\(FORMAT parquet\)/)
})

test('FORMATS is exactly the public enum', () => {
  assert.deepEqual([...FORMATS].sort(), ['csv', 'duckdb', 'json', 'parquet'])
})
