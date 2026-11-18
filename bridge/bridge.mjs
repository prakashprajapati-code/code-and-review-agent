import { StateManager } from './state.js'
import { GitWatcher } from './git.js'
import { GateRunner } from './gate.js'
import { SnapshotFreezer } from './snapshot.js'
import { McpServer } from './mcp.js'
import { SessionClient } from './session.js'
import { StreamableHTTPServerTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js'
import { isInitializeRequest } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js'
import { createServer } from 'http'
import 'dotenv/config'

/**
 * BridgeOrchestrator wires the concerns together and runs the full cycle:
 *
 *   idle -> gate -> snapshot freeze -> prompt Reviewer -> wait verdict ->
 *   (if NOT_READY) push findings to Developer -> wait resolve/skip -> loop
 *
 *   StateManager   -> persistent state (.review/findings.json, verdict.json, decisions.log)
 *   GitWatcher     -> tracked working-tree diff + content hash
 *   GateRunner     -> runs GATE_CMDS, captures output
 *   SnapshotFreezer-> freezes .review/cycle-NNN/{changes.patch, gate.txt, meta.json, files/}
 *   McpServer      -> exposes bridge_* tools over Streamable HTTP for Reviewer/Developer
 *   SessionClient  -> OpenCode session API for cross-terminal prompts
 */
export class BridgeOrchestrator {
  constructor() {
    this.repoRoot = process.env.BRIDGE_ROOT || process.cwd()
    this.reviewDir = `${this.repoRoot}/.review`
    this.idleMs = parseInt(process.env.IDLE_MS || '4000', 10)
    this.maxDiffBytes = 400 * 1024
    this.gateCmds = process.env.GATE_CMDS || 'npm test;;npm run lint;;npm audit'
    this.devUrl = process.env.DEV_URL || 'http://127.0.0.1:4096'
    this.revUrl = process.env.REV_URL || 'http://127.0.0.1:4097'
    this.stateManager = new StateManager(this.reviewDir)
    this.gitWatcher = new GitWatcher(this.repoRoot)
    this.gateRunner = new GateRunner(this.gateCmds)
    this.snapshotFreezer = new SnapshotFreezer(
      this.repoRoot, this.reviewDir, this.gateRunner, this.maxDiffBytes
    )
    this.revSessionClient = new SessionClient({
      baseUrl: this.revUrl,
      user: process.env.USER_NAME || 'opencode',
      pass: process.env.REV_URL_PASSWORD || ''
    })
    this.devSessionClient = new SessionClient({
      baseUrl: this.devUrl,
      user: process.env.USER_NAME || 'opencode',
      pass: process.env.DEV_URL_PASSWORD || ''
    })

    this.devSessionId = process.env.DEV_SESSION || null
    this.revSessionId = process.env.REV_SESSION || null
    this.pollIntervalMs = 2000
    this.pollMaxMs = 120000
    this.watchIntervalMs = Math.min(1000, this.idleMs)
    this.lastReviewedHash = ''
    this.observedHash = null
    this.quietSince = null
  }

  async discoverSessions() {
    // Discover Reviewer session
    if (this.revSessionId) {
      console.log(`Using Reviewer session from REV_SESSION: ${this.revSessionId}`)
    } else {
      try {
        console.log(`Reviewer base URL: ${this.revSessionClient.baseUrl}`)
        const revSessions = await this.revSessionClient.listSessions()
        if (revSessions.length > 0) {
          this.revSessionId = revSessions[0].id
          if (revSessions.length > 1) {
            console.log(`WARNING: multiple Reviewer sessions found, using ${this.revSessionId}`)
          }
        } else {
          // No sessions exist; create one
          const created = await this.revSessionClient.createSession()
          if (created) this.revSessionId = created
        }
      } catch (e) {
        console.log(`Reviewer session discovery skipped: ${e.message}`)
      }
    }

    // Discover Developer session
    if (this.devSessionId) {
      console.log(`Using Developer session from DEV_SESSION: ${this.devSessionId}`)
    } else {
      try {
        console.log(`Developer base URL: ${this.devSessionClient.baseUrl}`)
        const devSessions = await this.devSessionClient.listSessions()
        if (devSessions.length > 0) {
          this.devSessionId = devSessions[0].id
          if (devSessions.length > 1) {
            console.log(`WARNING: multiple Developer sessions found, using ${this.devSessionId}`)
          }
        } else {
          // No sessions exist; create one
          const created = await this.devSessionClient.createSession()
          if (created) this.devSessionId = created
        }
      } catch (e) {
        console.log(`Developer session discovery skipped: ${e.message}`)
      }
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

    const sessions = new Map()

    const server = createServer(async (req, res) => {
      try {
        let body
        if (req.method === 'POST') {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const raw = Buffer.concat(chunks).toString('utf8')
          try {
            body = raw ? JSON.parse(raw) : undefined
          } catch {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32700, message: 'Invalid JSON' },
              id: null
            }))
            return
          }
        }

        const sessionId = req.headers['mcp-session-id']
        if (req.method === 'GET' && !sessionId) {
          res.statusCode = 405
          res.end()
          return
        }
        let transport = sessionId ? sessions.get(sessionId) : undefined

        if (req.method === 'POST' && !transport && !sessionId && isInitializeRequest(body)) {
          const newTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sid) => sessions.set(sid, newTransport)
          })
          newTransport.onclose = () => {
            const sid = newTransport.sessionId
            if (sid) sessions.delete(sid)
          }
          const mcpServer = new McpServer(this.stateManager)
          await mcpServer.connect(newTransport)
          transport = newTransport
        }

        if (!transport) {
          res.statusCode = sessionId ? 404 : 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: sessionId ? 'Session not found' : 'Bad Request: No valid session ID provided'
            },
            id: null
          }))
          return
        }

        await transport.handleRequest(req, res, body)
      } catch (error) {
        console.error('Error handling MCP request:', error)
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null
          }))
        }
      }
    })
    const port = parseInt(process.env.BRIDGE_PORT || '5000', 10)
    server.listen(port, () => {
      console.log(`MCP server listening on http://127.0.0.1:${port}`)
    })

    await this.discoverSessions()

    while (true) {
      await new Promise(r => setTimeout(r, this.watchIntervalMs))

      const change = this.gitWatcher.readPatch()
      if (!change || !change.patch.trim()) {
        this.observedHash = null
        this.quietSince = null
        continue
      }

      if (change.hash === this.lastReviewedHash) {
        this.observedHash = change.hash
        this.quietSince = null
        continue
      }

      if (change.hash !== this.observedHash) {
        this.observedHash = change.hash
        this.quietSince = Date.now()
        console.log(`patch changed: ${change.hash.slice(0, 8)}`)
        continue
      }

      if (this.quietSince === null || Date.now() - this.quietSince < this.idleMs) continue

      const cycleName = this.snapshotFreezer.freeze({
        patch: change.patch,
        names: change.names
      })
      if (!cycleName) {
        console.log(`patch too large (> ${this.maxDiffBytes} bytes), skipping`)
        this.lastReviewedHash = change.hash
        this.observedHash = null
        this.quietSince = null
        continue
      }

      this.lastReviewedHash = change.hash
      this.observedHash = null
      this.quietSince = null
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
