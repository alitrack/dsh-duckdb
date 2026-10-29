import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCompatible, readOwnPackage, TESTED_TOOLS_RANGE } from '../lib/compat.js'

test('our declared peer range matches the installed dsh-tools rc line', () => {
  const pkg = readOwnPackage()
  const declared = pkg.peerDependencies['@deepseek-ai/dsh-tools']
  assert.ok(declared, 'package.json must declare @deepseek-ai/dsh-tools as a peer')
  assert.equal(declared, TESTED_TOOLS_RANGE)
})

test('isCompatible accepts the rc.1 line and rejects a different minor', () => {
  assert.equal(isCompatible('^0.0.1-rc.1', '0.0.1-rc.1'), true)
  assert.equal(isCompatible('^0.0.1-rc.1', '0.0.2-rc.1'), true)
  assert.equal(isCompatible('^0.0.1-rc.1', '0.0.1'), true)
  // A caret range on 0.0.x pins the minor in npm's own resolution rules, so
  // 0.1.0 is outside it.
  assert.equal(isCompatible('^0.0.1-rc.1', '0.1.0'), false)
})
