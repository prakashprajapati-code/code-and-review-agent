import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'

/**
 * SnapshotFreezer owns freezing a review cycle snapshot to disk:
 *   .review/cycle-NNN/
 *     changes.patch   -> read-only staged diff
 *     gate.txt        -> combined test/lint/audit output
 *     meta.json       -> cycle metadata (timestamp, patch size, gate cmds)
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

  freeze(patch) {
    if (Buffer.byteLength(patch, 'utf8') > this.maxDiffBytes) {
      return null // diff too large to review
    }

    const cycleName = this.nextCycleName()
    const cycleDir = join(this.reviewDir, cycleName)
    const filesDir = join(cycleDir, 'files')
    mkdirSync(cycleDir, { recursive: true })
    mkdirSync(filesDir, { recursive: true })

    const changed = this._getStagedDiffNames()
    for (const f of changed) {
      try {
        const full = join(this.repoRoot, f)
        if (existsSync(full)) {
          writeFileSync(join(filesDir, f.replace(/\//g, '__')), readFileSync(full))
        }
      } catch {
        // ignore unreadable files
      }
    }

    writeFileSync(join(cycleDir, 'changes.patch'), patch)
    writeFileSync(join(cycleDir, 'gate.txt'), this.gateRunner.run())
    writeFileSync(
      join(cycleDir, 'meta.json'),
      JSON.stringify({
        cycle: cycleName,
        timestamp: new Date().toISOString(),
        patch_size_bytes: Buffer.byteLength(patch, 'utf8'),
        gate_cmds: this.gateRunner.cmds.join(';;')
      }, null, 2)
    )

    return cycleName
  }

  _getStagedDiffNames() {
    return execSync(
      `git -C "${this.repoRoot}" diff --staged --name-only HEAD`,
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter(Boolean)
  }
}
