import { execSync } from 'child_process'
import { createHash } from 'crypto'

/**
 * GitWatcher owns all git interactions:
 *   - reading tracked working-tree changes (staged + unstaged)
 *   - reading the full patch (git diff HEAD)
 *   - content hashing for dedup
 */
export class GitWatcher {
  constructor(repoRoot) {
    this.repoRoot = repoRoot
  }

  readPatch() {
    try {
      const patch = execSync(
        `git -C "${this.repoRoot}" diff HEAD`,
        { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
      )
      if (!patch.trim()) {
        return { patch: '', names: [], hash: '' }
      }

      const names = execSync(
        `git -C "${this.repoRoot}" diff --name-only HEAD`,
        { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
      )
        .trim()
        .split('\n')
        .filter(Boolean)

      return { patch, names, hash: this.computeHash(patch) }
    } catch {
      return null
    }
  }

  computeHash(patch) {
    return createHash('sha256').update(patch).digest('hex')
  }
}
