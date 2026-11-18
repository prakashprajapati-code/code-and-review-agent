import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateManager } from '../bridge/state.js'

function makeState(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-state-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = new StateManager(dir)
  state.ensureDir()
  return state
}

test('finding status transitions and decision log', (t) => {
  const state = makeState(t)

  state.addFinding({
    id: 'F1',
    cycle: 'cycle-001',
    severity: 'high',
    category: 'bug',
    description: 'first'
  })
  state.addFinding({
    id: 'F2',
    cycle: 'cycle-001',
    severity: 'medium',
    category: 'tests',
    description: 'second'
  })

  assert.throws(
    () => state.addFinding({
      id: 'F1',
      cycle: 'cycle-001',
      severity: 'low',
      category: 'x',
      description: 'duplicate'
    }),
    /already exists/
  )

  state.addFinding({
    id: 'F1',
    cycle: 'cycle-002',
    severity: 'low',
    category: 'x',
    description: 'other cycle'
  })

  state.recordDecision('F1', 'resolve', null)
  assert.equal(
    state.getFindings().find(f => f.id === 'F1' && f.cycle === 'cycle-001').status,
    'in_progress'
  )

  assert.throws(
    () => state.recordDecision('F2', 'skip', '   '),
    /skip requires a reason/
  )

  state.recordDecision('F2', 'skip', 'accepted risk')
  assert.equal(state.getFindings().find(f => f.id === 'F2').status, 'skipped')

  state.resolveFinding('F1')
  assert.equal(
    state.getFindings().find(f => f.id === 'F1' && f.cycle === 'cycle-001').status,
    'resolved'
  )

  assert.equal(
    readFileSync(join(state.reviewDir, 'decisions.log'), 'utf8'),
    'resolve F1\nskip F2 because accepted risk\n'
  )
})
