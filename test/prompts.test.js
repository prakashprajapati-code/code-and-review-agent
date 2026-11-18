import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REVIEWER_RULES,
  buildDeveloperPrompt,
  buildReviewerPrompt
} from '../bridge/prompts.js'

test('reviewer prompt includes prior resolved and skipped context', () => {
  const prompt = buildReviewerPrompt({
    cycleName: 'cycle-002',
    gateOk: false,
    previousFindings: [
      {
        id: 'R1',
        cycle: 'cycle-001',
        severity: 'high',
        category: 'bug',
        description: 'fixed thing',
        status: 'resolved'
      },
      {
        id: 'S2',
        cycle: 'cycle-001',
        severity: 'medium',
        category: 'style',
        description: 'skipped thing',
        status: 'skipped',
        decision_reason: 'accepted by user'
      },
      {
        id: 'O3',
        cycle: 'cycle-001',
        severity: 'high',
        category: 'security',
        description: 'still open',
        status: 'in_progress'
      }
    ]
  })

  assert.match(prompt, /#R1/)
  assert.match(prompt, /accepted by user/)
  assert.match(prompt, /#O3/)
  assert.match(prompt, /Do not re-raise skipped findings/)
  assert.match(prompt, /bridge_get_state/)
  assert.match(prompt, /bridge_submit_verdict/)
  assert.match(prompt, /Gate: failed/)
})

test('reviewer rules cover the required review categories', () => {
  for (const category of [
    'Security',
    'Correctness',
    'Production readiness',
    'Tests',
    'Verdict'
  ]) {
    assert.match(REVIEWER_RULES, new RegExp(category))
  }
})

test('developer prompt includes findings and gate failure', () => {
  const prompt = buildDeveloperPrompt({
    cycleName: 'cycle-002',
    findings: [{
      id: 'F1',
      severity: 'high',
      category: 'bug',
      description: 'needs a fix',
      file: 'src/a.js',
      line: 4
    }],
    gateFailure: 'Failing commands:\n- npm test'
  })

  assert.match(prompt, /#F1/)
  assert.match(prompt, /src\/a\.js:4/)
  assert.match(prompt, /npm test/)
  assert.match(prompt, /bridge_record_decision/)
  assert.match(prompt, /bridge_mark_fixed/)
})
