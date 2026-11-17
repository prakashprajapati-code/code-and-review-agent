import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * StateManager owns all persistent state under .review/:
 *   findings.json   -> all review findings + status
 *   verdict.json    -> READY / NOT_READY verdict per cycle
 *   decisions.log   -> user's resolve/skip decisions in their own words
 *   cycle-NNN/      -> frozen snapshots (created by SnapshotFreezer)
 */
export class StateManager {
  constructor(reviewDir) {
    this.reviewDir = reviewDir
    this.findingsFile = join(reviewDir, 'findings.json')
    this.verdictFile = join(reviewDir, 'verdict.json')
    this.decisionsLog = join(reviewDir, 'decisions.log')
  }

  ensureDir() {
    if (!existsSync(this.reviewDir)) {
      mkdirSync(this.reviewDir, { recursive: true })
    }
  }

  readJson(file, def) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return def
    }
  }

  writeJson(file, data) {
    writeFileSync(file, JSON.stringify(data, null, 2))
  }

  // ---- findings ----
  getFindings() {
    return this.readJson(this.findingsFile, [])
  }

  addFinding(finding) {
    const findings = this.getFindings()
    findings.push({ ...finding, status: 'open', decided_at: null })
    this.writeJson(this.findingsFile, findings)
    return findings
  }

  resolveFinding(id) {
    const findings = this.getFindings()
    const f = findings.find(x => x.id === id)
    if (f) {
      f.status = 'resolved'
      f.decided_at = new Date().toISOString()
    }
    this.writeJson(this.findingsFile, findings)
    return f
  }

  // ---- verdict ----
  getVerdict() {
    return this.readJson(this.verdictFile, null)
  }

  setVerdict(cycle, verdict) {
    const record = { cycle, verdict, timestamp: new Date().toISOString() }
    this.writeJson(this.verdictFile, record)
    return record
  }

  // ---- decisions log ----
  appendDecision(line) {
    this.ensureDir()
    writeFileSync(this.decisionsLog, line + '\n', { flag: 'a' })
  }

  // ---- cycles ----
  getCycles() {
    this.ensureDir()
    return readdirSync(this.reviewDir)
      .filter(e => e.startsWith('cycle-'))
      .sort()
  }

  // ---- aggregate state exposed via MCP ----
  getState() {
    return {
      findings: this.getFindings(),
      verdict: this.getVerdict(),
      cycles: this.getCycles()
    }
  }
}
