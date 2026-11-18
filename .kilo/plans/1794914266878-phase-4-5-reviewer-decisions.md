# Plan: Phase 4 & 5 — Reviewer drive & Developer decisions

## Goal
Complete the cross-terminal loop: snapshot freeze → prompt Reviewer → wait verdict → (if NOT_READY) push findings to Developer → wait resolve/skip → loop.

## Current state (phases 1–3 code done, phases 4–5 code written but broken)

Code exists for all of phases 4–5 but `npm run bridge` fails with 401 on both Developer and Reviewer session discovery:

| File | Status | Issue |
|------|--------|-------|
| `bridge/session.js` | Written | `btoa()` is not available in Node (use `Buffer.from().toString('base64')`); unused `import { config } from 'zod/v4'`; `_headers()` hardcodes username `opencode` instead of `OPENCODE_USER` env var |
| `bridge/bridge.mjs` | Written | Dev URL defaults to port 4098 (should be 4096); hardcoded auth tokens on lines 39-40 instead of `OPENCODE_USER`/`OPENCODE_PASS` env vars; debug `console.log(this.revSessionClient)` / `console.log(this.devSessionClient)` left in on lines 51, 65 |
| `bridge/state.js` | Written | `recordDecision` complete ✓ |
| `bridge/mcp.js` | Written | `bridge_record_decision` tool complete ✓ |

## Fixes required (in order)

1. **`bridge/session.js`**: Replace `btoa()` with `Buffer.from(\`${user}:${pass}\`).toString('base64')`. Read `OPENCODE_USER` (default `opencode`) and `OPENCODE_PASS` (required) from env. Remove unused zod import.
2. **`bridge/bridge.mjs`**: Change `devUrl` default from `http://localhost:4098` to `http://127.0.0.1:4096`. Remove hardcoded tokens; read `OPENCODE_USER`/`OPENCODE_PASS` from env. Remove debug `console.log` calls.
3. **`bridge/bridge.mjs`**: Handle empty session list — if `GET /api/session` returns no sessions, create one via `POST /api/session` before prompting.

## Configuration (set before running)
- `OPENCODE_USER=opencode` (default)
- `OPENCODE_PASS=<password from server's "server open" output>`
- `DEV_URL=http://127.0.0.1:4096` (default)
- `REV_URL=http://127.0.0.1:4097` (default)

## Open questions (confirm before running end-to-end)
1. Are `DEV_URL=http://127.0.0.1:4096` and `REV_URL=http://127.0.0.1:4097` correct for your OpenCode instances?
2. What is the exact password from your server's "server open" output?
3. How to distinguish Developer vs Reviewer sessions from `GET /api/session`? (by directory, creation order, or title?)

## Exit criteria for phases 4–5
- `node --check bridge/session.js`, `bridge/state.js`, `bridge/mcp.js`, `bridge/bridge.mjs` all pass.
- `OPENCODE_USER` and `OPENCODE_PASS` set; `npm run bridge` starts without 401 errors on session discovery.
- Reviewer submits a finding + verdict; both persisted to `findings.json` / `verdict.json`.
- Findings pushed to Developer terminal via session API.
- `resolve`/`skip` recorded with exact words in `decisions.log`.
- Skipped items not re-raised in next cycle.
