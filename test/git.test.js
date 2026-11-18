import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitWatcher } from '../bridge/git.js'

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-git-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  execFileSync('git', ['add', 'a.txt'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}

test('GitWatcher reads unstaged, staged, and changed content', (t) => {
  const dir = makeRepo(t)
  const watcher = new GitWatcher(dir)

  assert.deepEqual(watcher.readPatch(), { patch: '', names: [], hash: '' })

  writeFileSync(join(dir, 'untracked.txt'), 'ignored\n')
  assert.deepEqual(watcher.readPatch(), { patch: '', names: [], hash: '' })

  writeFileSync(join(dir, 'a.txt'), 'two\n')
  const unstaged = watcher.readPatch()
  assert.deepEqual(unstaged.names, ['a.txt'])
  assert.match(unstaged.patch, /\+two/)
  assert.equal(unstaged.hash.length, 64)

  execFileSync('git', ['add', 'a.txt'], { cwd: dir })
  const staged = watcher.readPatch()
  assert.equal(staged.hash, unstaged.hash)

  writeFileSync(join(dir, 'a.txt'), 'three\n')
  const changed = watcher.readPatch()
  assert.notEqual(changed.hash, unstaged.hash)

  writeFileSync(join(dir, 'a.txt'), 'two\n')
  const reverted = watcher.readPatch()
  assert.equal(reverted.hash, staged.hash)
})
