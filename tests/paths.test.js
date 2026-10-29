import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { validateWorkspaceFile, isWithin } from '../lib/paths.js'

const ROOT = '/tmp/dsh-duckdb-test-ws'
const OUTSIDE = '/tmp/dsh-duckdb-test-outside'

function setup() {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  mkdirSync(OUTSIDE, { recursive: true })
  writeFileSync(`${ROOT}/data.csv`, 'a,b\n1,x\n')
  writeFileSync(`${OUTSIDE}/secret.csv`, 'a\n1\n')
}

test('accepts an absolute file inside the workspace', () => {
  setup()
  const v = validateWorkspaceFile(`${ROOT}/data.csv`, ROOT)
  assert.equal(v.ok, true)
  assert.equal(v.path, `${ROOT}/data.csv`)
})

test('rejects a relative path', () => {
  setup()
  const v = validateWorkspaceFile('data.csv', ROOT)
  assert.equal(v.ok, false)
  assert.equal(v.code, 'NOT_ABSOLUTE')
})

test('rejects .. traversal', () => {
  setup()
  const v = validateWorkspaceFile(`${ROOT}/../dsh-duckdb-test-outside/secret.csv`, ROOT)
  assert.equal(v.ok, false)
  assert.equal(v.code, 'ESCAPE')
})

test('rejects a symlink pointing outside the workspace', () => {
  setup()
  symlinkSync(`${OUTSIDE}/secret.csv`, `${ROOT}/link.csv`)
  const v = validateWorkspaceFile(`${ROOT}/link.csv`, ROOT)
  assert.equal(v.ok, false)
  assert.equal(v.code, 'SYMLINK_ESCAPE')
})

test('rejects an absolute path to an outside file', () => {
  setup()
  const v = validateWorkspaceFile(`${OUTSIDE}/secret.csv`, ROOT)
  assert.equal(v.ok, false)
  assert.equal(v.code, 'ESCAPE')
})

test('rejects a missing file', () => {
  setup()
  const v = validateWorkspaceFile(`${ROOT}/nope.csv`, ROOT)
  assert.equal(v.ok, false)
  assert.equal(v.code, 'MISSING')
})

test('rejects a directory', () => {
  setup()
  const v = validateWorkspaceFile(ROOT, ROOT)
  assert.equal(v.ok, false)
  assert.equal(v.code, 'NOT_A_FILE')
})

test('rejects empty input', () => {
  setup()
  assert.equal(validateWorkspaceFile('', ROOT).code, 'EMPTY')
  assert.equal(validateWorkspaceFile('   ', ROOT).code, 'EMPTY')
})

test('isWithin: root itself, child, sibling', () => {
  assert.equal(isWithin('/a/b', '/a/b'), true)
  assert.equal(isWithin('/a/b/c', '/a/b'), true)
  assert.equal(isWithin('/a/bc', '/a/b'), false)
  assert.equal(isWithin('/a', '/a/b'), false)
})
