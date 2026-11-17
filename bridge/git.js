import { execSync } from 'child_process'

/**
 * GitWatcher owns all git interactions:
 *   - reading staged file names (diff --staged --name-only HEAD)
 *   - reading the full staged patch (diff --staged)
 *   - change detection + dedup via hash of the staged diff
 */
export class GitWatcher {
  constructor(repoRoot, idleMs = 4000) {
    this.repoRoot = repoRoot
    this.idleMs = idleMs
    this.lastDiffHash = ''
  }

  getStagedDiff() {
    return execSync(
      `git -C "${this.repoRoot}" diff --staged --name-only HEAD`,
      { encoding: 'utf8' }
    ).trim()
  }

  getStagedPatch() {
    return execSync(`git -C "${this.repoRoot}" diff --staged`, {
      encoding: 'utf8'
    })
  }

  computeHash(diffOutput) {
    return Buffer.from(diffOutput).toString('base64').slice(0, 16)
  }

  /**
   * Returns true when a new staged diff is present since the last processed one.
   * Updates the internal last-seen hash so identical re-staged diffs are skipped.
   */
  hasNewDiff() {
    let diffOutput
    try {
      diffOutput = this.getStagedDiff()
    } catch {
      return false
    }
    if (!diffOutput) return false

    const hash = this.computeHash(diffOutput)
    if (hash === this.lastDiffHash) return false

    this.lastDiffHash = hash
    return true
  }

  /**
   * Waits one idle tick (idleMs) then returns the current staged diff output,
   * or null if nothing is staged.
   */
  async pollIdle() {
    await new Promise(r => setTimeout(r, this.idleMs))
    try {
      return this.getStagedDiff()
    } catch {
      return null
    }
  }
}
