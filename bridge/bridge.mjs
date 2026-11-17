import { execSync } from 'child_process'

async function watch() {
  const fs = await import('fs')
  const path = process.argv[2] || '.'
  const changes = []
  while (true) {
    const out = execSync(`git -C ${process.cwd()} diff --staged --name-only HEAD`, { encoding: 'utf8' })
    // parse new/modified files
    console.log(out)
    // sleep briefly
    await new Promise(r => setTimeout(r, 2000))
  }
}

watch()
