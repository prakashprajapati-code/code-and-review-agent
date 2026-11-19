#!/usr/bin/env node
/**
 * MCP Proxy - connects to remote bridge MCP server via HTTP/streamableHttp
 * and exposes tools via stdio for OpenCode
 */

import { fileURLToPath } from 'url'

const sdkBase = fileURLToPath(
  new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url)
)
const { Client } = await import(sdkBase + 'client/index.js')
const { StreamableHTTPClientTransport } = await import(sdkBase + 'client/streamableHttp.js')
const { StdioServerTransport } = await import(sdkBase + 'server/stdio.js')
const { Server } = await import(sdkBase + 'server/index.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = await import(sdkBase + 'types.js')

const BRIDGE_URL = process.env.BRIDGE_URL
if (!BRIDGE_URL) {
  console.error('BRIDGE_URL is required (use /mcp/reviewer or /mcp/developer)')
  process.exit(1)
}

async function main() {
  // Connect to remote bridge
  const client = new Client(
    { name: 'mcp-proxy', version: '1.0.0' },
    { capabilities: {} }
  )

  const transport = new StreamableHTTPClientTransport(new URL(BRIDGE_URL))
  await client.connect(transport)

  // Get tools from bridge
  const toolsResult = await client.listTools()
  const tools = toolsResult.tools

  console.error(`Connected to bridge at ${BRIDGE_URL}, found ${tools.length} tools`)

  // Create local stdio server that forwards to bridge
  const server = new Server(
    { name: 'opencode-review-bridge-proxy', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    try {
      const result = await client.callTool({ name, arguments: args })
      return result
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: error.message }) }],
        isError: true
      }
    }
  })

  const stdioTransport = new StdioServerTransport()
  await server.connect(stdioTransport)
  console.error('MCP proxy ready on stdio')
}

main().catch(err => {
  console.error('Proxy error:', err)
  process.exit(1)
})
