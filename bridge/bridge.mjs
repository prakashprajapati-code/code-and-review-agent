import { StateManager } from './state.js'
import { GitWatcher } from './git.js'
import { GateRunner } from './gate.js'
import { SnapshotFreezer } from './snapshot.js'
import { McpServer } from './mcp.js'
import { SessionClient } from './session.js'
import { StdioServerTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js'
import 'dotenv/config'

/**
 * BridgeOrchestrator wires the concerns together and runs the full cycle:
 *
 *   idle -> gate -> snapshot freeze -> prompt Reviewer -> wait verdict ->
 *   (if NOT_READY) push findings to Developer -> wait resolve/skip -> loop
 *
 *   StateManager   -> persistent state (.review/findings.json, verdict.json, decisions.log)
 *   GitWatcher     -> git staged-diff polling + dedup
 *   GateRunner     -> runs GATE_CMDS, captures output
 *   SnapshotFreezer-> freezes .review/cycle-NNN/{changes.patch, gate.txt, meta.json, files/}
 *   McpServer      -> exposes bridge_* tools over stdio for Reviewer/Developer
 *   SessionClient  -> OpenCode session API for cross-terminal prompts
 */
export class BridgeOrchestrator {
  constructor() {
    this.repoRoot = process.env.BRIDGE_ROOT || process.cwd()
    this.reviewDir = `${this.repoRoot}/.review`
    this.idleMs = parseInt(process.env.IDLE_MS || '4000', 10)
    this.maxDiffBytes = 400 * 1024
    this.gateCmds = process.env.GATE_CMDS || 'npm test;;npm run lint;;npm audit'
    this.devUrl = process.env.DEV_URL   
    this.revUrl = process.env.REV_URL
    this.stateManager = new StateManager(this.reviewDir)
    this.gitWatcher = new GitWatcher(this.repoRoot, this.idleMs)
    this.gateRunner = new GateRunner(this.gateCmds)
    this.snapshotFreezer = new SnapshotFreezer(
      this.repoRoot, this.reviewDir, this.gateRunner, this.maxDiffBytes
    )
    this.mcpServer = new McpServer(this.stateManager)
    this.revSessionClient = new SessionClient({ baseUrl: this.revUrl ,authToken :process.env.REV_URL_PASSWORD })
    this.devSessionClient = new SessionClient({ baseUrl: this.devUrl ,authToken : process.env.DEV_URL_PASSWORD})

    this.devSessionId = null
    this.revSessionId = null
    this.pollIntervalMs = 2000
    this.pollMaxMs = 120000
  }

  async discoverSessions() {
    // Discover Reviewer session
    try {
      console.log(this.revSessionClient)
      const revSessions = await this.revSessionClient.listSessions()
      if (revSessions.length > 0) {
        this.revSessionId = revSessions[0].id
        if (revSessions.length > 1) {
          console.log(`WARNING: multiple Reviewer sessions found, using ${this.revSessionId}`)
        }
      }
    } catch (e) {
      console.log(`Reviewer session discovery skipped: ${e.message}`)
    }

    // Discover Developer session
    try {
       console.log(this.devSessionClient)
      const devSessions = await this.devSessionClient.listSessions()
      if (devSessions.length > 0) {
        this.devSessionId = devSessions[0].id
        if (devSessions.length > 1) {
          console.log(`WARNING: multiple Developer sessions found, using ${this.devSessionId}`)
        }
      }
    } catch (e) {
      console.log(`Developer session discovery skipped: ${e.message}`)
    }
  }

  async waitForVerdict(cycleName) {
    let elapsed = 0
    while (elapsed < this.pollMaxMs) {
      await new Promise(r => setTimeout(r, this.pollIntervalMs))
      const state = this.stateManager.getState()
      const verdict = state.verdict
      if (verdict && verdict.cycle === cycleName) {
        return verdict
      }
      elapsed += this.pollIntervalMs
    }
    return null
  }

  async waitForDecisions(cycleFindingIds) {
    let elapsed = 0
    while (elapsed < this.pollMaxMs) {
      await new Promise(r => setTimeout(r, this.pollIntervalMs))
      const state = this.stateManager.getState()
      const findings = state.findings
      const allDecided = cycleFindingIds.every(id => {
        const f = findings.find(x => x.id === id)
        return f && (f.status === 'resolved' || f.status === 'skipped')
      })
      if (allDecided) return true
      elapsed += this.pollIntervalMs
    }
    return false
  }

  async start() {
    this.stateManager.ensureDir()

    const transport = new StdioServerTransport()
    await this.mcpServer.connect(transport)

    await this.discoverSessions()

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
      if (!cycleName) continue
      console.log(`snapshot frozen: ${cycleName}`)

      // ---- Phase 4: Prompt Reviewer ----
      if (this.revSessionId) {
        const prompt = `Review snapshot cycle ${cycleName}. Gate output and changed files are in .review/${cycleName}/. Submit each issue with bridge_submit_finding, then give a verdict with bridge_submit_verdict (READY or NOT_READY).`
        try {
          await this.revSessionClient.sendPromptAsync(this.revSessionId, prompt)
          console.log(`prompted reviewer: ${cycleName}`)
        } catch (e) {
          console.log(`reviewer prompt failed: ${e.message}`)
        }
      }

      const verdict = await this.waitForVerdict(cycleName)
      if (!verdict) {
        console.log(`no verdict for ${cycleName}, continuing to next cycle`)
        continue
      }

      if (verdict.verdict === 'READY') {
        console.log(`cycle ${cycleName} READY`)
        continue
      }

      // ---- Phase 5: Push findings to Developer ----
      const state = this.stateManager.getState()
      const cycleFindings = state.findings.filter(
        f => f.cycle === cycleName && f.status === 'open'
      )

      if (this.devSessionId && cycleFindings.length > 0) {
        const findingList = cycleFindings
          .map(f => `- #${f.id} [${f.severity}] ${f.category}: ${f.description}`)
          .join('\n')
        const prompt = `Review findings for cycle ${cycleName}:\n${findingList}\n\nFor each finding, reply: resolve <id> or skip <id> because <reason>. I will record your decisions.`
        try {
          await this.devSessionClient.sendPromptAsync(this.devSessionId, prompt)
          console.log(`pushed findings to developer: ${cycleName}`)
        } catch (e) {
          console.log(`developer prompt failed: ${e.message}`)
        }
      }

      const findingIds = cycleFindings.map(f => f.id)
      const decided = await this.waitForDecisions(findingIds)
      if (decided) {
        console.log(`all findings decided for ${cycleName}`)
      } else {
        console.log(`not all findings decided for ${cycleName} within poll window`)
      }
    }
  }
}

const bridge = new BridgeOrchestrator()
bridge.start().catch(err => {
  console.error(err)
  process.exit(1)
})
