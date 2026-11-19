import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const ROLE_KEYS = {
  developer: 'DEV_URL_PASSWORD',
  reviewer: 'REV_URL_PASSWORD'
}

const [role, command, ...args] = process.argv.slice(2)
const key = ROLE_KEYS[role]

if (!key) {
  console.error('role must be developer or reviewer')
  process.exit(1)
}

if (!command) {
  console.error('command is required')
  process.exit(1)
}

let envText
try {
  envText = readFileSync('.env', 'utf8')
} catch {
  console.error('.env is required')
  process.exit(1)
}

const password = dotenv.parse(envText)[key]
if (!password) {
  console.error(`${key} is required in .env`)
  process.exit(1)
}

let roleConfig
try {
  roleConfig = readFileSync(`${repoRoot}config/${role}.json`, 'utf8')
} catch {
  console.error(`config/${role}.json is required (see .env.example / README)`)
  process.exit(1)
}

// Pass only this role's password. Do not export the rest of .env to the agent process.
const env = { ...process.env, OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: roleConfig }
delete env.DEV_URL_PASSWORD
delete env.REV_URL_PASSWORD

const child = spawn(command, args, { stdio: 'inherit', env })

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => {
  console.error(error.message)
  process.exit(1)
})

child.on('exit', (code) => {
  process.exit(code ?? 1)
})
