import test from 'node:test'
import assert from 'node:assert/strict'
import { countOpenHighMedium, shouldStop, validateVerdict } from '../bridge/policy.js'

const findings = [
  { id: 'F1', cycle: 'cycle-001', severity: 'high', status: 'open' },
  { id: 'F2', cycle: 'cycle-001', severity: 'medium', status: 'in_progress' },
  { id: 'F3', cycle: 'cycle-001', severity: 'low', status: 'open' },
  { id: 'F4', cycle: 'cycle-001', severity: 'critical', status: 'resolved' },
  { id: 'F5', cycle: 'cycle-001', severity: 'high', status: 'skipped' },
  { id: 'F6', cycle: 'cycle-002', severity: 'critical', status: 'open' }
]

test('countOpenHighMedium counts unresolved medium/high/critical findings', () => {
  assert.equal(countOpenHighMedium(findings, 'cycle-001'), 2)
  assert.equal(countOpenHighMedium(findings), 3)
})

test('validateVerdict enforces gate and unresolved findings', () => {
  assert.deepEqual(
    validateVerdict({ verdict: 'READY', findings, gateOk: false, cycle: 'cycle-001' }),
    { valid: false, reason: 'gate failed' }
  )
  assert.deepEqual(
    validateVerdict({ verdict: 'READY', findings, gateOk: true, cycle: 'cycle-001' }),
    { valid: false, reason: '2 unresolved high/medium finding(s)' }
  )
  assert.deepEqual(
    validateVerdict({ verdict: 'READY', findings, gateOk: true, cycle: 'cycle-003' }),
    { valid: true, reason: null }
  )
  assert.deepEqual(
    validateVerdict({ verdict: 'NOT_READY', findings, gateOk: false, cycle: 'cycle-001' }),
    { valid: true, reason: null }
  )
})

test('shouldStop stops on max cycles or a valid READY', () => {
  assert.deepEqual(
    shouldStop({
      verdict: 'NOT_READY',
      gateOk: false,
      findings,
      cycle: 'cycle-001',
      cyclesRun: 1,
      maxCycles: 1
    }),
    { stop: true, reason: 'max cycles reached (1)' }
  )
  assert.deepEqual(
    shouldStop({
      verdict: 'READY',
      gateOk: true,
      findings,
      cycle: 'cycle-003',
      cyclesRun: 1,
      maxCycles: 8
    }),
    { stop: true, reason: 'validated READY' }
  )
  assert.deepEqual(
    shouldStop({
      verdict: 'READY',
      gateOk: true,
      findings,
      cycle: 'cycle-001',
      cyclesRun: 1,
      maxCycles: 8
    }),
    { stop: false, reason: '2 unresolved high/medium finding(s)' }
  )
  assert.deepEqual(
    shouldStop({
      verdict: 'NOT_READY',
      gateOk: true,
      findings,
      cycle: 'cycle-001',
      cyclesRun: 1,
      maxCycles: 8
    }),
    { stop: false, reason: null }
  )
})
