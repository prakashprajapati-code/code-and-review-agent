import { StateManager } from './state.js'
import { GitWatcher } from './git.js'
import { GateRunner } from './gate.js'
import { SnapshotFreezer } from './snapshot.js'
import { McpServer } from './mcp.js'
import { SessionClient } from './session.js'
import { validateVerdict, shouldStop } from './policy.js'
import { buildReviewerPrompt, buildDeveloperPrompt } from './prompts.js'
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
    this.reviewDir = process.env.REVIEW_DIR || `${this.repoRoot}/.review`
    this.idleMs = parseInt(process.env.IDLE_MS || '4000', 10)
    const maxCycles = parseInt(process.env.MAX_CYCLES || '8', 10)
    // MAX_CYCLES is a per-process budget, not total cycles on disk.
    this.maxCycles = Number.isFinite(maxCycles) ? maxCycles : 8
    this.cyclesRun = 0
    this.maxDiffBytes = 400 * 1024
    this.gateCmds = process.env.GATE_CMDS || 'npm test;;npm run lint;;npm audit --audit-level=high'
    this.devUrl = process.env.DEV_URL || 'http://127.0.0.1:4096'
    this.revUrl = process.env.REV_URL || 'http://127.0.0.1:4097'
    this.stateManager = new StateManager(this.reviewDir)
    this.gitWatcher = new GitWatcher(this.repoRoot)
    this.gateRunner = new GateRunner(this.gateCmds, this.repoRoot)
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
    this.discoveryTimeoutMs = parseInt(process.env.DISCOVERY_TIMEOUT_MS || '60000', 10)
    this.discoveryRetryMs = parseInt(process.env.DISCOVERY_RETRY_MS || '2000', 10)
    this.lastDiscoveryAttempt = 0
    this.pollIntervalMs = 2000
    this.pollMaxMs = 120000
    this.watchIntervalMs = Math.min(1000, this.idleMs)
    this.lastReviewedHash = ''
    this.observedHash = null
    this.quietSince = null
  }

  async _discoverRole(kind) {
    const isRev = kind === 'reviewer'
    const client = isRev ? this.revSessionClient : this.devSessionClient
    const envId = isRev ? this.revSessionId : this.devSessionId
    const label = isRev ? 'Reviewer' : 'Developer'
    if (envId) {
      console.log(`Using ${label} session from env: ${envId}`)
      return
    }
    try {
      console.log(`${label} base URL: ${client.baseUrl}`)
      // dev and review servers share a project session store, so both roles
      // would pick the same first-listed session; create fresh ones instead.
      // Pin existing sessions with DEV_SESSION / REV_SESSION.
      let id = await client.createSession()
      if (!id) {
        const sessions = await client.listSessions()
        id = sessions.length > 0 ? sessions[0].id : null
      }
      if (id) {
        if (isRev) this.revSessionId = id
        else this.devSessionId = id
        console.log(`${label} session ready: ${id}`)
      }
    } catch (e) {
      console.log(`${label} session discovery failed: ${e.message}`)
    }
  }

  async discoverSessions() {
    const deadline = Date.now() + this.discoveryTimeoutMs
    while (true) {
      if (!this.revSessionId) await this._discoverRole('reviewer')
      if (!this.devSessionId) await this._discoverRole('developer')
      if (this.revSessionId && this.devSessionId) return
      if (Date.now() >= deadline) {
        console.log('session discovery timed out; will retry in the main loop')
        return
      }
      await new Promise(r => setTimeout(r, this.discoveryRetryMs))
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
        return f && (f.status === 'in_progress' || f.status === 'resolved' || f.status === 'skipped')
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
        const path = req.url.split('?')[0]
        const role = path === '/mcp/reviewer'
          ? 'reviewer'
          : path === '/mcp/developer'
            ? 'developer'
            : null
        if (!role) {
          res.statusCode = 404
          res.end()
          return
        }

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
        const session = sessionId ? sessions.get(sessionId) : undefined
        if (session && session.role !== role) {
          res.statusCode = 403
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: `Session is bound to ${session.role}, not ${role}`
            },
            id: null
          }))
          return
        }
        let transport = session ? session.transport : undefined

        if (req.method === 'POST' && !transport && !sessionId && isInitializeRequest(body)) {
          const newTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sid) => sessions.set(sid, { transport: newTransport, role })
          })
          newTransport.onclose = () => {
            const sid = newTransport.sessionId
            if (sid) sessions.delete(sid)
          }
          const mcpServer = new McpServer(this.stateManager, role)
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
      console.log(`MCP server listening on http://127.0.0.1:${port}/mcp/reviewer and /mcp/developer`)
    })

    await this.discoverSessions()

    while (true) {
      if (this.cyclesRun >= this.maxCycles) {
        console.log(`max cycles reached (${this.maxCycles})`)
        break
      }
      await new Promise(r => setTimeout(r, this.watchIntervalMs))

      if (!this.revSessionId || !this.devSessionId) {
        const now = Date.now()
        if (now - this.lastDiscoveryAttempt > 10000) {
          this.lastDiscoveryAttempt = now
          if (!this.revSessionId) await this._discoverRole('reviewer')
          if (!this.devSessionId) await this._discoverRole('developer')
        }
      }

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

      const frozen = this.snapshotFreezer.freeze({
        patch: change.patch,
        names: change.names
      })
      if (!frozen) {
        console.log(`patch too large (> ${this.maxDiffBytes} bytes), skipping`)
        this.lastReviewedHash = change.hash
        this.observedHash = null
        this.quietSince = null
        continue
      }

      const { cycleName, gateOk, gateResults } = frozen
      this.cyclesRun += 1
      this.lastReviewedHash = change.hash
      this.observedHash = null
      this.quietSince = null
      console.log(`snapshot frozen: ${cycleName}`)
      console.log(`gate ${gateOk ? 'passed' : 'failed'}: ${cycleName}`)

      // ---- Phase 4: Prompt Reviewer ----
      if (this.revSessionId) {
        const previousFindings = this.stateManager.getState().findings
          .filter(f => f.cycle !== cycleName)
        const prompt = buildReviewerPrompt({ cycleName, gateOk, previousFindings, snapshotDir: `${this.reviewDir}/${cycleName}` })
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

      const state = this.stateManager.getState()
      const validation = validateVerdict({
        verdict: verdict.verdict,
        findings: state.findings,
        gateOk,
        cycle: cycleName
      })

      if (verdict.verdict === 'READY') {
        if (validation.valid) {
          console.log(`validated READY: ${cycleName}`)
          break
        }
        console.log(`READY rejected for ${cycleName}: ${validation.reason}`)
      }

      // ---- Phase 5: Push findings to Developer ----
      const cycleFindings = state.findings.filter(
        f => f.cycle === cycleName && f.status === 'open'
      )
      const failing = gateOk ? [] : gateResults.filter(r => !r.ok).map(r => r.cmd)
      const gateFailure = gateOk
        ? null
        : `Failing commands:\n${failing.map(c => `- ${c}`).join('\n')}\nSee ${this.reviewDir}/${cycleName}/gate.txt for output.`

      if (this.devSessionId && (cycleFindings.length > 0 || gateFailure)) {
        const prompt = buildDeveloperPrompt({ cycleName, findings: cycleFindings, gateFailure, snapshotDir: `${this.reviewDir}/${cycleName}` })
        try {
          await this.devSessionClient.sendPromptAsync(this.devSessionId, prompt)
          console.log(`pushed developer prompt: ${cycleName}`)
        } catch (e) {
          console.log(`developer prompt failed: ${e.message}`)
        }
      }

      const findingIds = cycleFindings.map(f => f.id)
      const decided = findingIds.length === 0
        ? true
        : await this.waitForDecisions(findingIds)
      if (findingIds.length > 0) {
        if (decided) {
          console.log(`all findings decided for ${cycleName}`)
        } else {
          console.log(`not all findings decided for ${cycleName} within poll window`)
        }
      }

      const stop = shouldStop({
        verdict: verdict.verdict,
        gateOk,
        findings: state.findings,
        cycle: cycleName,
        cyclesRun: this.cyclesRun,
        maxCycles: this.maxCycles
      })
      if (stop.stop) {
        console.log(stop.reason)
        break
      }
    }
  }
}

const bridge = new BridgeOrchestrator()
bridge.start().catch(err => {
  console.error(err)
  process.exit(1)
})
