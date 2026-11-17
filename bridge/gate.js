import { execSync } from 'child_process'

/**
 * GateRunner owns running the quality gate:
 *   - splits GATE_CMDS on ';;'
 *   - runs each command with execSync, capturing stdout+stderr
 *   - returns combined output for storage in cycle-NNN/gate.txt
 */
export class GateRunner {
  constructor(gateCmds) {
    this.cmds = gateCmds.split(';;').filter(Boolean)
  }

  run() {
    let output = ''
    for (const cmd of this.cmds) {
      try {
        const out = execSync(cmd, {
          cwd: process.cwd(),
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024
        })
        output += `\n=== $ ${cmd} ===\n${out}\n`
      } catch (e) {
        output += `\n=== $ ${cmd} (exit ${e.status}) ===\n`
        output += (e.stdout && e.stdout.toString) ? e.stdout.toString() : ''
        output += (e.stderr && e.stderr.toString) ? e.stderr.toString() : ''
        output += '\n'
      }
    }
    return output
  }
}
