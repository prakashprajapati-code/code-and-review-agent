import { StateManager } from './state.js'
import { GitWatcher } from './git.js'
import { GateRunner } from './gate.js'
import { SnapshotFreezer } from './snapshot.js'
import { McpServer } from './mcp.js'
import { StdioServerTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js'

/**
 * BridgeOrchestrator wires the five concerns together and runs the idle -> gate -> snapshot loop:
 *
 *   StateManager   -> persistent state (.review/findings.json, verdict.json, decisions.log)
 *   GitWatcher     -> git staged-diff polling + dedup
 *   GateRunner     -> runs GATE_CMDS, captures output
 *   SnapshotFreezer-> freezes .review/cycle-NNN/{changes.patch, gate.txt, meta.json, files/}
 *   McpServer      -> exposes bridge_* tools over stdio for the Reviewer terminal
 */
export class BridgeOrchestrator {
  constructor() {
    this.repoRoot = process.env.BRIDGE_ROOT || process.cwd()
    this.reviewDir = `${this.repoRoot}/.review`
    this.idleMs = parseInt(process.env.IDLE_MS || '4000', 10)
    this.maxDiffBytes = 400 * 1024
    this.gateCmds = process.env.GATE_CMDS || 'npm test;;npm run lint;;npm audit'

    this.stateManager = new StateManager(this.reviewDir)
    this.gitWatcher = new GitWatcher(this.repoRoot, this.idleMs)
    this.gateRunner = new GateRunner(this.gateCmds)
    this.snapshotFreezer = new SnapshotFreezer(
      this.repoRoot, this.reviewDir, this.gateRunner, this.maxDiffBytes
    )
    this.mcpServer = new McpServer(this.stateManager)
  }

  async start() {
    this.stateManager.ensureDir()

    const transport = new StdioServerTransport()
    await this.mcpServer.connect(transport)

    while (true) {
      await new Promise(r => setTimeout(r, this.idleMs))

      if (!this.gitWatcher.hasNewDiff()) continue

      let patch
      try {
        patch = this.gitWatcher.getStagedPatch()
      } catch {
        continue
      }

      const cycleName = this.snapshotFreezer.freeze(patch)
      if (cycleName) {
        console.log(`snapshot frozen: ${cycleName}`)
      }
    }
  }
}

const bridge = new BridgeOrchestrator()
bridge.start().catch(err => {
  console.error(err)
  process.exit(1)
})
