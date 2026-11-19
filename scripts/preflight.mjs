#!/usr/bin/env node
/**
 * Preflight checks for `npm start`. Exits non-zero with fix hints on failure.
 */

import { execSync, spawnSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { fileURLToPath } from 'url'
import { randomBytes } from 'crypto'

const root = fileURLToPath(new URL('..', import.meta.url))
const failures = []
const ok = []

function check(label, fn) {
  try {
    const detail = fn()
    ok.push(`  ✓ ${label}${detail ? ` (${detail})` : ''}`)
  } catch (e) {
    failures.push(`  ✗ ${label}\n      fix: ${e.message}`)
  }
}

check('git repository with at least one commit', () => {
  try {
    execSync('git rev-parse HEAD', { cwd: root, stdio: 'pipe' })
  } catch {
    throw new Error('run: git init && git commit --allow-empty -m init')
  }
})

check('opencode on PATH', () => {
  const res = spawnSync('opencode', ['--version'], { encoding: 'utf8' })
  if (res.error) throw new Error('install opencode (https://opencode.ai) and ensure it is on PATH')
  return (res.stdout || '').trim()
})

check('.env present with passwords', () => {
  const envPath = `${root}.env`
  if (!existsSync(envPath)) {
    const example = existsSync(`${root}.env.example`)
      ? readFileSync(`${root}.env.example`, 'utf8')
      : ''
    const dev = randomBytes(24).toString('base64url')
    const rev = randomBytes(24).toString('base64url')
    writeFileSync(
      envPath,
      example
        .replace(/^DEV_URL_PASSWORD=.*$/m, `DEV_URL_PASSWORD=${dev}`)
        .replace(/^REV_URL_PASSWORD=.*$/m, `REV_URL_PASSWORD=${rev}`),
      { mode: 0o600 }
    )
    return 'created .env with random passwords'
  }
  const content = readFileSync(envPath, 'utf8')
  const missing = ['DEV_URL_PASSWORD', 'REV_URL_PASSWORD'].filter(
    k => !new RegExp(`^${k}=.+`, 'm').test(content)
  )
  if (missing.length) {
    throw new Error(
      `add ${missing.join(', ')} to .env (see .env.example), e.g. node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`
    )
  }
  if (/DEV_URL_PASSWORD=change-me/.test(content) || /REV_URL_PASSWORD=change-me/.test(content)) {
    throw new Error('.env still has the placeholder passwords; set random values')
  }
  return 'found'
})

for (const port of [4096, 4097, 5000]) {
  await new Promise(resolve => {
    const srv = createServer()
    srv.once('error', () => {
      failures.push(`  ✗ port ${port} free\n      fix: stop the process using it (lsof -ti :${port} | xargs kill)`)
      resolve()
    })
    srv.once('listening', () => {
      srv.close(() => {
        ok.push(`  ✓ port ${port} free`)
        resolve()
      })
    })
    srv.listen(port, '127.0.0.1')
  })
}

console.log('Preflight:')
console.log(ok.join('\n'))
if (failures.length) {
  console.error('Preflight failed:')
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('All checks passed.')
