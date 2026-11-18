# Plan: Phase 4 & 5 — Reviewer drive & Developer decisions

## Goal
Complete the cross-terminal loop: snapshot freeze → prompt Reviewer → wait verdict → (if NOT_READY) push findings to Developer → wait resolve/skip → loop.

## Changes made by phase (already coded, needs fixes)

| Phase | File | Change |
|-------|------|--------|
| 2 | `bridge/state.js` | `StateManager`: findings.json, verdict.json, decisions.log |
| 2 | `bridge/git.js` | `GitWatcher`: staged diff polling + dedup |
| 2 | `bridge/gate.js` | `GateRunner`: runs `GATE_CMDS` |
| 2 | `bridge/snapshot.js` | `SnapshotFreezer`: freezes `.review/cycle-NNN/` |
| 2 | `bridge/mcp.js` | `McpServer`: 5 tools (`bridge_submit_finding`, `bridge_submit_verdict`, `bridge_mark_fixed`, `bridge_record_decision`, `bridge_get_state`) |
| 3 | `bridge/bridge.mjs` | `BridgeOrchestrator`: MCP server + idle → gate → snapshot loop |
| 4 | `bridge/session.js` | `SessionClient`: OpenCode session API (`listSessions`, `sendPromptAsync`) |
| 4 | `bridge/mcp.js` | Added `bridge_record_decision` tool |
| 5 | `bridge/bridge.mjs` | Added reviewer prompt + verdict wait + developer push + decision wait |

## Fixes required (in order)

1. **`bridge/session.js`**: Replace `btoa()` with `Buffer.from(\`${user}:${pass}\`).toString('base64')`. Accept `user`/`pass` in constructor; read env `OPENCODE_USER`/`OPENCODE_PASS`. Remove unused zod import.
2. **`bridge/bridge.mjs`**: Dev URL default → `http://127.0.0.1:4096`. Remove hardcoded auth tokens; read `OPENCODE_DEV_PASS`/`OPENCODE_REV_PASS` from env. Remove debug `console.log` calls.
3. **`bridge/bridge.mjs`**: If `GET /api/session` returns empty, create one via `POST /api/session` before prompting.

## Smooth setup — one command
```bash
export OPENCODE_DEV_PASS=<dev-terminal-password> \
     OPENCODE_REV_PASS=<reviewer-terminal-password> \
     OPENCODE_USER=opencode && npm run bridge
```
(`DEV_URL=http://127.0.0.1:4096`, `REV_URL=http://127.0.0.1:4097` by default.)

## Open questions (confirm before running end-to-end)
1. Are `DEV_URL=http://127.0.0.1:4096` and `REV_URL=http://127.0.0.1:4097` correct?
2. What are the exact passwords from each terminal's "server open" output?
3. How to distinguish Developer vs Reviewer sessions from `GET /api/session`? (by directory, creation order, or title?)

## Exit criteria for phases 4–5
- `node --check bridge/session.js bridge/mcp.js bridge/bridge.mjs` all pass.
- `npm run bridge` starts without 401 errors on session discovery.
- Reviewer submits finding + verdict → persisted to `findings.json` / `verdict.json`.
- Findings pushed to Developer terminal via session API.
- `resolve`/`skip` recorded in `decisions.log`; skipped items not re-raised next cycle.
