/**
 * SessionClient owns OpenCode session API interactions:
 *   - list sessions on an instance (GET /api/session)
 *   - get session status (GET /api/session/{id}/status)
 *   - send prompt_async to a session (POST /api/session/{id}/prompt_async)
 *
 * All configuration comes from constructor options or env vars — nothing
 * is hardcoded beyond sensible defaults that you can override.
 */

import { config } from "zod/v4"

export class SessionClient {
  constructor({ baseUrl, authToken } = {}) {
    this.baseUrl = baseUrl || process.env.REV_URL
    this.authToken = authToken || process.env.OPENCODE_AUTH_TOKEN || undefined
  }

  _headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra }
    if (this.authToken) h.Authorization ="Basic " + btoa(`opencode:${this.authToken}`)
    return h
  }

  async listSessions() {
    const res = await fetch(`${this.baseUrl}/api/session`, {headers: this._headers()})
    if (!res.ok) throw new Error(`listSessions failed: ${res.status} ${await res.text()}`)
    const json = await res.json()
    return Array.isArray(json) ? json : (json.data ?? [])
  }

  async getSessionStatus(sessionId) {
    const res = await fetch(`${this.baseUrl}/api/session/${sessionId}/status`, {
      headers: this._headers()
    })
    if (!res.ok) throw new Error(`getSessionStatus failed: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async sendPromptAsync(sessionId, text) {
    const body = JSON.stringify({ parts: [{ type: 'text', text }] })
    const res = await fetch(`${this.baseUrl}/api/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: this._headers(),
      body
    })
    if (!res.ok) throw new Error(`sendPromptAsync failed: ${res.status} ${await res.text()}`)
    return res.status === 204
  }
}
