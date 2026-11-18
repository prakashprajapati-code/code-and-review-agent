import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * SnapshotFreezer owns freezing a review cycle snapshot to disk:
 *   .review/cycle-NNN/
 *     changes.patch   -> read-only working-tree diff
 *     gate.txt        -> combined test/lint/audit output
 *     meta.json       -> cycle metadata (timestamp, patch size, gate cmds, gate status)
 *     files/          -> full copies of each changed file
 */
export class SnapshotFreezer {
  constructor(repoRoot, reviewDir, gateRunner, maxDiffBytes = 400 * 1024) {
    this.repoRoot = repoRoot
    this.reviewDir = reviewDir
    this.gateRunner = gateRunner
    this.maxDiffBytes = maxDiffBytes
  }

  nextCycleName() {
    const cycles = this._listCycles()
    const n = cycles.length === 0
      ? 1
      : parseInt(cycles[cycles.length - 1].replace('cycle-', ''), 10) + 1
    return `cycle-${String(n).padStart(3, '0')}`
  }

  _listCycles() {
    if (!existsSync(this.reviewDir)) return []
    return readdirSync(this.reviewDir)
      .filter(e => e.startsWith('cycle-'))
      .sort()
  }

  freeze({ patch, names }) {
    if (Buffer.byteLength(patch, 'utf8') > this.maxDiffBytes) {
      return null // diff too large to review
    }

    const cycleName = this.nextCycleName()
    const cycleDir = join(this.reviewDir, cycleName)
    const filesDir = join(cycleDir, 'files')
    mkdirSync(cycleDir, { recursive: true })
    mkdirSync(filesDir, { recursive: true })

    for (const f of names) {
      try {
        const full = join(this.repoRoot, f)
        if (existsSync(full)) {
          writeFileSync(join(filesDir, f.replace(/\//g, '__')), readFileSync(full))
        }
      } catch {
        // ignore unreadable files
      }
    }

    const gate = this.gateRunner.run()

    writeFileSync(join(cycleDir, 'changes.patch'), patch)
    writeFileSync(join(cycleDir, 'gate.txt'), gate.output)
    writeFileSync(
      join(cycleDir, 'meta.json'),
      JSON.stringify({
        cycle: cycleName,
        timestamp: new Date().toISOString(),
        patch_size_bytes: Buffer.byteLength(patch, 'utf8'),
        gate_cmds: this.gateRunner.cmds.join(';;'),
        gate_ok: gate.ok,
        gate_results: gate.results
      }, null, 2)
    )

    return { cycleName, gateOk: gate.ok, gateResults: gate.results }
  }
}
