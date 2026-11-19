import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('../bridge/run-role.mjs', import.meta.url))
const inspect = `process.stdout.write(JSON.stringify({
  pass: process.env.OPENCODE_PASSWORD ?? null,
  dev: process.env.DEV_URL_PASSWORD ?? null,
  rev: process.env.REV_URL_PASSWORD ?? null,
  other: process.env.OTHER_SECRET ?? null,
  config: process.env.OPENCODE_CONFIG ?? null
}))`

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-role-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function runHelper(cwd, args, extraEnv = {}) {
  const env = { ...process.env }
  delete env.DEV_URL_PASSWORD
  delete env.REV_URL_PASSWORD
  delete env.OTHER_SECRET
  delete env.OPENCODE_PASSWORD
  Object.assign(env, extraEnv)
  return spawnSync(process.execPath, [helper, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  })
}

test('developer role receives only the developer password', (t) => {
  const dir = makeTempDir(t)
  writeFileSync(join(dir, '.env'), [
    'DEV_URL_PASSWORD=dev-secret',
    'REV_URL_PASSWORD=rev-secret',
    'OTHER_SECRET=leak',
    ''
  ].join('\n'))

  const result = runHelper(
    dir,
    ['developer', process.execPath, '-e', inspect],
    { OPENCODE_CONFIG: './opencode.developer.json' }
  )

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    pass: 'dev-secret',
    dev: null,
    rev: null,
    other: null,
    config: './opencode.developer.json'
  })
})

test('reviewer role receives only the reviewer password', (t) => {
  const dir = makeTempDir(t)
  writeFileSync(join(dir, '.env'), [
    'DEV_URL_PASSWORD=dev-secret',
    'REV_URL_PASSWORD=rev-secret',
    ''
  ].join('\n'))

  const result = runHelper(
    dir,
    ['reviewer', process.execPath, '-e', inspect],
    { OPENCODE_CONFIG: './opencode.reviewer.json' }
  )

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    pass: 'rev-secret',
    dev: null,
    rev: null,
    other: null,
    config: './opencode.reviewer.json'
  })
})

test('missing .env fails closed', (t) => {
  const dir = makeTempDir(t)
  const result = runHelper(dir, ['developer', process.execPath, '-e', '0'])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /\.env is required/)
})

test('missing role password fails closed', (t) => {
  const dir = makeTempDir(t)
  writeFileSync(join(dir, '.env'), 'DEV_URL_PASSWORD=dev-secret\n')
  const result = runHelper(dir, ['reviewer', process.execPath, '-e', '0'])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /REV_URL_PASSWORD is required/)
})
