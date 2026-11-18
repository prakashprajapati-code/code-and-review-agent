export const REVIEWER_RULES = `You are a read-only code reviewer for a production Node.js/Next.js codebase.

Review the frozen snapshot, not the live working tree. The snapshot contains changes.patch, full changed files under files/, and gate.txt.

Rules:
- Security: check authentication, authorization, input validation, injection, secrets, unsafe file or network access, and data exposure.
- Correctness: check logic errors, edge cases, error handling, races, null/undefined handling, and regressions.
- Production readiness: check migrations, configuration, observability, failure behavior, performance, and backward compatibility.
- Tests: check that behavior changes have meaningful tests and that existing tests cover regressions.
- Evidence: cite file and line when possible. Do not invent issues; inspect more context when unsure.
- IDs: use a stable ID that is unique within this review cycle.
- Previous findings: verify resolved fixes. Do not re-raise a skipped finding unless its skip reason is clearly wrong. Report a regression as a new finding.
- Workflow: call bridge_get_state if you need current findings or verdicts. Submit all findings with bridge_submit_finding before calling bridge_submit_verdict.
- Verdict: submit READY only when the gate passed and there are no unresolved medium, high, or critical findings. Otherwise submit NOT_READY.
- Do not modify files or run shell commands.`

function formatFinding(f) {
  const location = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''
  const reasonText = f.decision_reason || f.reason
  const reason = reasonText ? ` — reason: ${reasonText}` : ''
  return `- #${f.id} [${f.severity}] ${f.category}: ${f.description}${location}${reason}`
}

function formatPreviousFindings(findings) {
  if (!findings || findings.length === 0) {
    return 'Previous findings: none.'
  }

  const groups = {
    resolved: findings.filter(f => f.status === 'resolved'),
    skipped: findings.filter(f => f.status === 'skipped'),
    unresolved: findings.filter(f => f.status === 'open' || f.status === 'in_progress')
  }
  const known = new Set(['resolved', 'skipped', 'open', 'in_progress'])
  const other = findings.filter(f => !known.has(f.status))

  const parts = ['Previous findings:']
  if (groups.resolved.length > 0) {
    parts.push('Resolved (verify the fix):')
    parts.push(...groups.resolved.map(formatFinding))
  }
  if (groups.skipped.length > 0) {
    parts.push('Skipped (do not re-raise unless the reason is clearly wrong):')
    parts.push(...groups.skipped.map(formatFinding))
  }
  if (groups.unresolved.length > 0) {
    parts.push('Still open or in progress:')
    parts.push(...groups.unresolved.map(formatFinding))
  }
  if (other.length > 0) {
    parts.push('Other:')
    parts.push(...other.map(formatFinding))
  }

  return parts.join('\n')
}

export function buildReviewerPrompt({ cycleName, gateOk, previousFindings = [] }) {
  return `${REVIEWER_RULES}

Cycle: ${cycleName}
Gate: ${gateOk ? 'passed' : 'failed'}
Snapshot: .review/${cycleName}/ (changes.patch, files/, gate.txt)

${formatPreviousFindings(previousFindings)}

Instructions:
- Verify each resolved finding against the current snapshot. If a fix is missing or incomplete, submit a new finding.
- Do not re-raise skipped findings unless the recorded skip reason is clearly wrong.
- Re-check still-open or in-progress findings and submit updated findings if needed.
- Call bridge_get_state if you need the full current state.
- Submit findings with bridge_submit_finding before submitting your verdict with bridge_submit_verdict.`
}

export function buildDeveloperPrompt({ cycleName, findings = [], gateFailure = null }) {
  const findingText = findings.length > 0
    ? findings.map(formatFinding).join('\n')
    : 'No review findings.'
  const gateText = gateFailure
    ? `\nGate failure:\n${gateFailure}\n`
    : ''

  return `You are the developer fixing review findings.

Cycle: ${cycleName}
Snapshot: .review/${cycleName}/

Findings:
${findingText}
${gateText}
Instructions:
- For each finding, get the user's decision.
- If the decision is resolve, call bridge_record_decision with decision "resolve", fix the issue, then call bridge_mark_fixed when the fix is complete.
- If the decision is skip, call bridge_record_decision with decision "skip" and the user's exact reason. Skip without a reason is rejected.
- If the gate failed, run the failing commands, fix the failures, and leave the changes in the working tree.
- Do not edit .review/ or change the frozen snapshot.`
}
