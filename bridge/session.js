/**
 * SessionClient owns OpenCode session API interactions:
 *   - list sessions on an instance (GET /api/session)
 *   - get session status (GET /api/session/{id}/status)
 *   - send a prompt to a session (POST /api/session/{id}/prompt)
 *
 * All configuration comes from constructor options or env vars — nothing
 * is hardcoded beyond sensible defaults that you can override.
 */

export class SessionClient {
  constructor({ baseUrl, user, pass } = {}) {
    this.baseUrl = baseUrl || process.env.REV_URL || 'http://127.0.0.1:4097'
    this.user = user ||'opencode'
    this.pass = pass || ''
  }

  _headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra }
    if (this.pass) {
      const token = Buffer.from(`${this.user}:${this.pass}`).toString('base64')
      h.Authorization = `Basic ${token}`
    }
    return h
  }

  async createSession() {
    const res = await fetch(`${this.baseUrl}/api/session`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({})
    })
    if (!res.ok) throw new Error(`createSession failed: ${res.status} ${await res.text()}`)
    const json = await res.json()
    return json.data?.id || json.id || null
  }

  async listSessions() {
    const res = await fetch(`${this.baseUrl}/api/session`, { headers: this._headers() })
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
    const body = JSON.stringify({ text })
    const res = await fetch(`${this.baseUrl}/api/session/${sessionId}/prompt`, {
      method: 'POST',
      headers: this._headers(),
      body
    })
    if (!res.ok) throw new Error(`sendPromptAsync failed: ${res.status} ${await res.text()}`)
    return true
  }
}
