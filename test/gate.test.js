import test from 'node:test'
import assert from 'node:assert/strict'
import { GateRunner } from '../bridge/gate.js'

test('GateRunner returns pass results', () => {
  const result = new GateRunner('true', process.cwd()).run()
  assert.equal(result.ok, true)
  assert.deepEqual(result.results, [{ cmd: 'true', ok: true, exitCode: 0 }])
  assert.match(result.output, /=== \$ true ===/)
})

test('GateRunner returns fail results and captured output', () => {
  const result = new GateRunner('true;;false', process.cwd()).run()
  assert.equal(result.ok, false)
  assert.deepEqual(result.results, [
    { cmd: 'true', ok: true, exitCode: 0 },
    { cmd: 'false', ok: false, exitCode: 1 }
  ])
  assert.match(result.output, /\(exit 1\)/)
})
