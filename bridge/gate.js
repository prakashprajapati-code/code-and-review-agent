import { execSync } from 'child_process'

/**
 * GateRunner owns running the quality gate:
 *   - splits GATE_CMDS on ';;'
 *   - runs each command with execSync, capturing stdout+stderr
 *   - returns combined output plus per-command success
 */
export class GateRunner {
  constructor(gateCmds, cwd = process.cwd()) {
    this.cmds = gateCmds.split(';;').filter(Boolean)
    this.cwd = cwd
  }

  run() {
    let output = ''
    const results = []

    for (const cmd of this.cmds) {
      try {
        const out = execSync(cmd, {
          cwd: this.cwd,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024
        })
        results.push({ cmd, ok: true, exitCode: 0 })
        output += `\n=== $ ${cmd} ===\n${out}\n`
      } catch (e) {
        const exitCode = Number.isInteger(e.status) ? e.status : null
        results.push({ cmd, ok: false, exitCode })
        output += `\n=== $ ${cmd} (exit ${exitCode}) ===\n`
        output += (e.stdout && e.stdout.toString) ? e.stdout.toString() : ''
        output += (e.stderr && e.stderr.toString) ? e.stderr.toString() : ''
        output += '\n'
      }
    }

    return {
      output,
      ok: results.every(r => r.ok),
      results
    }
  }
}
