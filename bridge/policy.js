const BLOCKING_SEVERITIES = new Set(['medium', 'high', 'critical'])
const UNRESOLVED_STATUSES = new Set(['open', 'in_progress'])

export function countOpenHighMedium(findings, cycle) {
  return findings.filter(f =>
    (!cycle || f.cycle === cycle) &&
    UNRESOLVED_STATUSES.has(f.status) &&
    BLOCKING_SEVERITIES.has(f.severity)
  ).length
}

export function validateVerdict({ verdict, findings, gateOk, cycle }) {
  if (verdict !== 'READY') {
    return { valid: true, reason: null }
  }
  if (!gateOk) {
    return { valid: false, reason: 'gate failed' }
  }

  const blocking = countOpenHighMedium(findings, cycle)
  if (blocking > 0) {
    return { valid: false, reason: `${blocking} unresolved high/medium finding(s)` }
  }

  return { valid: true, reason: null }
}

export function shouldStop({ verdict, gateOk, findings, cyclesRun, maxCycles, cycle }) {
  if (cyclesRun >= maxCycles) {
    return { stop: true, reason: `max cycles reached (${maxCycles})` }
  }
  if (verdict !== 'READY') {
    return { stop: false, reason: null }
  }

  const validation = validateVerdict({ verdict, findings, gateOk, cycle })
  if (!validation.valid) {
    return { stop: false, reason: validation.reason }
  }

  return { stop: true, reason: 'validated READY' }
}
