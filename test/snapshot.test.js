import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotFreezer } from '../bridge/snapshot.js'

function makeGate() {
  return {
    cmds: ['true'],
    run: () => ({
      output: 'ok',
      ok: true,
      results: [{ cmd: 'true', ok: true, exitCode: 0 }]
    })
  }
}

test('SnapshotFreezer rejects a large diff before creating a cycle', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-snapshot-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const freezer = new SnapshotFreezer(dir, join(dir, '.review'), makeGate())
  const result = freezer.freeze({
    patch: 'x'.repeat(400 * 1024 + 1),
    names: []
  })

  assert.equal(result, null)
  assert.equal(existsSync(join(dir, '.review')), false)
})

test('SnapshotFreezer writes gate metadata and returns gate status', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-snapshot-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const freezer = new SnapshotFreezer(dir, join(dir, '.review'), makeGate())
  const result = freezer.freeze({ patch: 'diff\n', names: [] })

  assert.deepEqual(result, {
    cycleName: 'cycle-001',
    gateOk: true,
    gateResults: [{ cmd: 'true', ok: true, exitCode: 0 }]
  })

  const meta = JSON.parse(
    readFileSync(join(dir, '.review', 'cycle-001', 'meta.json'), 'utf8')
  )
  assert.equal(meta.gate_ok, true)
  assert.deepEqual(meta.gate_results, [{ cmd: 'true', ok: true, exitCode: 0 }])
})
