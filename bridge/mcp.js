import { Server } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js'
import { z } from 'zod'

/**
 * McpServer owns the Model Context Protocol surface:
 *   - exposes 4 tools: bridge_submit_finding, bridge_submit_verdict,
 *     bridge_mark_fixed, bridge_get_state
 *   - validates inputs with zod
 *   - delegates state mutations to StateManager
 */
export class McpServer {
  constructor(stateManager) {
    this.stateManager = stateManager
    this.server = new Server(
      { name: 'opencode-review-bridge', version: '2.1.0' },
      { capabilities: { tools: {} } }
    )
    this._registerHandlers()
  }

  _registerHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'bridge_submit_finding',
          description: 'Submit a review finding',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              cycle: { type: 'string' },
              severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
              category: { type: 'string' },
              description: { type: 'string' },
              file: { type: 'string' },
              line: { type: 'number' },
              reason: { type: 'string' }
            },
            required: ['id', 'cycle', 'severity', 'category', 'description']
          }
        },
        {
          name: 'bridge_submit_verdict',
          description: 'Submit a review verdict',
          inputSchema: {
            type: 'object',
            properties: {
              cycle: { type: 'string' },
              verdict: { type: 'string', enum: ['READY', 'NOT_READY'] }
            },
            required: ['cycle', 'verdict']
          }
        },
        {
          name: 'bridge_mark_fixed',
          description: 'Mark a finding as resolved',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id']
          }
        },
        {
          name: 'bridge_record_decision',
          description: 'Record a resolve or skip decision with the user exact words',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              decision: { type: 'string', enum: ['resolve', 'skip'] },
              reason: { type: 'string' }
            },
            required: ['id', 'decision']
          }
        },
        {
          name: 'bridge_get_state',
          description: 'Get current bridge state',
          inputSchema: { type: 'object', properties: {} }
        }
      ]
    }))

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params

      if (name === 'bridge_submit_finding') {
        const parsed = z.object({
          id: z.string(),
          cycle: z.string(),
          severity: z.enum(['low', 'medium', 'high', 'critical']),
          category: z.string(),
          description: z.string(),
          file: z.string().optional(),
          line: z.number().optional(),
          reason: z.string().optional()
        }).parse(args)
        this.stateManager.addFinding(parsed)
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
      }

      if (name === 'bridge_submit_verdict') {
        const parsed = z.object({
          cycle: z.string(),
          verdict: z.enum(['READY', 'NOT_READY'])
        }).parse(args)
        this.stateManager.setVerdict(parsed.cycle, parsed.verdict)
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
      }

      if (name === 'bridge_mark_fixed') {
        const parsed = z.object({ id: z.string() }).parse(args)
        this.stateManager.resolveFinding(parsed.id)
        this.stateManager.appendDecision(`resolve ${parsed.id}`)
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
      }

      if (name === 'bridge_record_decision') {
        const parsed = z.object({
          id: z.string(),
          decision: z.enum(['resolve', 'skip']),
          reason: z.string().optional()
        }).parse(args)
        this.stateManager.recordDecision(parsed.id, parsed.decision, parsed.reason || null)
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
      }

      if (name === 'bridge_get_state') {
        return {
          content: [{ type: 'text', text: JSON.stringify(this.stateManager.getState()) }]
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'unknown tool' }) }]
      }
    })
  }

  async connect(transport) {
    await this.server.connect(transport)
  }
}
