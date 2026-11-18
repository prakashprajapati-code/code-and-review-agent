import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { InMemoryTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js'
import { McpServer, isToolAllowed, toolsForRole } from '../bridge/mcp.js'
import { StateManager } from '../bridge/state.js'

async function connectRole(role, stateManager) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client(
    { name: `test-${role}`, version: '1.0.0' },
    { capabilities: {} }
  )
  const server = new McpServer(stateManager, role)
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport)
  ])
  return { client, server }
}

function payload(result) {
  assert.ok(result.content?.[0]?.text, 'missing result content')
  return JSON.parse(result.content[0].text)
}

test('role helpers expose exactly the intended tools', () => {
  assert.deepEqual(
    toolsForRole('reviewer').map(t => t.name).sort(),
    ['bridge_get_state', 'bridge_submit_finding', 'bridge_submit_verdict']
  )
  assert.deepEqual(
    toolsForRole('developer').map(t => t.name).sort(),
    ['bridge_get_state', 'bridge_mark_fixed', 'bridge_record_decision']
  )
  assert.equal(isToolAllowed('reviewer', 'bridge_mark_fixed'), false)
  assert.equal(isToolAllowed('developer', 'bridge_submit_finding'), false)
  assert.equal(isToolAllowed('reviewer', 'bridge_get_state'), true)
  assert.equal(isToolAllowed('developer', 'bridge_get_state'), true)
})

test('MCP role filtering, cross-role rejection, and duplicate IDs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-mcp-'))
  const stateManager = new StateManager(dir)
  stateManager.ensureDir()

  const rev = await connectRole('reviewer', stateManager)
  const dev = await connectRole('developer', stateManager)
  t.after(async () => {
    await rev.client.close()
    await dev.client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  assert.equal((await rev.client.listTools()).tools.length, 3)
  assert.equal((await dev.client.listTools()).tools.length, 3)

  const reviewerState = payload(await rev.client.callTool({
    name: 'bridge_get_state',
    arguments: {}
  }))
  const developerState = payload(await dev.client.callTool({
    name: 'bridge_get_state',
    arguments: {}
  }))
  assert.ok(Array.isArray(reviewerState.findings))
  assert.ok(Array.isArray(developerState.findings))

  const reviewerMarkFixed = await rev.client.callTool({
    name: 'bridge_mark_fixed',
    arguments: { id: 'F1' }
  })
  assert.equal(reviewerMarkFixed.isError, true)
  assert.match(payload(reviewerMarkFixed).error, /not allowed/)

  const developerSubmit = await dev.client.callTool({
    name: 'bridge_submit_finding',
    arguments: {
      id: 'F1',
      cycle: 'cycle-001',
      severity: 'high',
      category: 'bug',
      description: 'not allowed'
    }
  })
  assert.equal(developerSubmit.isError, true)
  assert.match(payload(developerSubmit).error, /not allowed/)

  const submitted = await rev.client.callTool({
    name: 'bridge_submit_finding',
    arguments: {
      id: 'F1',
      cycle: 'cycle-001',
      severity: 'high',
      category: 'bug',
      description: 'first'
    }
  })
  assert.notEqual(submitted.isError, true)

  const duplicate = await rev.client.callTool({
    name: 'bridge_submit_finding',
    arguments: {
      id: 'F1',
      cycle: 'cycle-001',
      severity: 'high',
      category: 'bug',
      description: 'duplicate'
    }
  })
  assert.equal(duplicate.isError, true)
  assert.match(payload(duplicate).error, /already exists/)

  const prematureReady = await rev.client.callTool({
    name: 'bridge_submit_verdict',
    arguments: { cycle: 'cycle-001', verdict: 'READY' }
  })
  assert.equal(prematureReady.isError, true)
  assert.match(payload(prematureReady).error, /unresolved high\/medium/)

  await dev.client.callTool({
    name: 'bridge_record_decision',
    arguments: { id: 'F1', decision: 'resolve' }
  })
  await dev.client.callTool({
    name: 'bridge_mark_fixed',
    arguments: { id: 'F1' }
  })

  const ready = await rev.client.callTool({
    name: 'bridge_submit_verdict',
    arguments: { cycle: 'cycle-001', verdict: 'READY' }
  })
  assert.notEqual(ready.isError, true)
})
