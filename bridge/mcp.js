import { Server } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js'
import { z } from 'zod'
import { countOpenHighMedium } from './policy.js'

const TOOL_DEFS = {
  bridge_submit_finding: {
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
  bridge_submit_verdict: {
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
  bridge_mark_fixed: {
    name: 'bridge_mark_fixed',
    description: 'Mark a finding as resolved after the fix is complete',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  bridge_record_decision: {
    name: 'bridge_record_decision',
    description: 'Record a resolve or skip decision with the user exact words',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        decision: { type: 'string', enum: ['resolve', 'skip'] },
        reason: { type: 'string', description: 'Required when decision is skip' }
      },
      required: ['id', 'decision']
    }
  },
  bridge_get_state: {
    name: 'bridge_get_state',
    description: 'Get current bridge state',
    inputSchema: { type: 'object', properties: {} }
  }
}

const ROLE_TOOLS = {
  reviewer: ['bridge_submit_finding', 'bridge_submit_verdict', 'bridge_get_state'],
  developer: ['bridge_mark_fixed', 'bridge_record_decision', 'bridge_get_state']
}

export function toolsForRole(role) {
  return (ROLE_TOOLS[role] || []).map(name => TOOL_DEFS[name])
}

export function isToolAllowed(role, name) {
  return (ROLE_TOOLS[role] || []).includes(name)
}

function textResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

function errorResult(message) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }],
    isError: true
  }
}

/**
 * McpServer owns the Model Context Protocol surface:
 *   - exposes only the tools allowed for its role
 *   - validates inputs with zod
 *   - delegates state mutations to StateManager
 */
export class McpServer {
  constructor(stateManager, role) {
    this.stateManager = stateManager
    this.role = role
    this.server = new Server(
      { name: 'opencode-review-bridge', version: '2.1.0' },
      { capabilities: { tools: {} } }
    )
    this._registerHandlers()
  }

  _registerHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: toolsForRole(this.role)
    }))

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params

      if (!isToolAllowed(this.role, name)) {
        return errorResult(`tool ${name} is not allowed for role ${this.role}`)
      }

      try {
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
          return textResult({ ok: true })
        }

        if (name === 'bridge_submit_verdict') {
          const parsed = z.object({
            cycle: z.string(),
            verdict: z.enum(['READY', 'NOT_READY'])
          }).parse(args)
          if (parsed.verdict === 'READY') {
            const blocking = countOpenHighMedium(this.stateManager.getFindings(), parsed.cycle)
            if (blocking > 0) {
              throw new Error(`READY rejected: ${blocking} unresolved high/medium finding(s)`)
            }
          }
          this.stateManager.setVerdict(parsed.cycle, parsed.verdict)
          return textResult({ ok: true })
        }

        if (name === 'bridge_mark_fixed') {
          const parsed = z.object({ id: z.string() }).parse(args)
          this.stateManager.resolveFinding(parsed.id)
          return textResult({ ok: true })
        }

        if (name === 'bridge_record_decision') {
          const parsed = z.object({
            id: z.string(),
            decision: z.enum(['resolve', 'skip']),
            reason: z.string().optional()
          }).parse(args)
          this.stateManager.recordDecision(parsed.id, parsed.decision, parsed.reason || null)
          return textResult({ ok: true })
        }

        if (name === 'bridge_get_state') {
          return textResult(this.stateManager.getState())
        }

        return errorResult(`unknown tool: ${name}`)
      } catch (e) {
        return errorResult(e.message)
      }
    })
  }

  async connect(transport) {
    await this.server.connect(transport)
  }
}
