# OpenCode Developer + Reviewer bridge

```
Terminal 1  Developer (OpenCode, you chat here)  <--MCP /mcp/developer--+
                                                                         +-- Bridge (Node: MCP server + orchestrator)
Terminal 2  Reviewer  (OpenCode, read-only)      <--MCP /mcp/reviewer---+
```

## Flow
1. You ask the Developer to build something (Terminal 1).
2. Developer goes idle -> bridge runs the **gate** (tests, lint, `npm audit`, optional gitleaks/semgrep) and freezes a snapshot in `.review/cycle-NNN/`.
3. Reviewer (Terminal 2) reads the snapshot and reports each issue with the `bridge_submit_finding` MCP tool, then a `READY` / `NOT_READY` verdict.
4. **Findings appear in the Developer terminal.** The Developer explains each one and asks you: **resolve** or **skip (reason)**.
5. You answer there, e.g. `resolve 1 and 3, skip 2 because it is only used in tests`.
6. Developer records your decisions (`bridge_set_resolution`, logged in `.review/decisions.log` with your words), fixes only the resolved ones, runs tests, calls `bridge_mark_fixed`.
7. It goes idle -> next cycle. The reviewer verifies fixed items and does not re-raise skipped ones unless your reason is clearly wrong. Stops when gate passes, no findings, verdict READY (or after `MAX_CYCLES`).

## Setup
```bash
cd your-project           # must be a git repo with >= 1 commit
cp /path/to/bridge/{bridge.mjs,package.json,opencode.developer.json,opencode.reviewer.json} .
npm install
```

## Run (4 consoles)
| Console | Commands |
|---|---|
| A: Bridge | `npm run bridge` (start this first; set `GATE_CMDS` if needed) |
| B: Developer | `npm run dev` (or `dev:server` + `dev:tui`) |
| C: Reviewer | `npm run review` (or `review:server` + `review:tui`) |

Check that OpenCode loaded the bridge tools: `opencode mcp list` (run with the same `OPENCODE_CONFIG`).

## Settings (env vars)
- `GATE_CMDS="npm test;;npm run lint;;gitleaks detect --no-git;;semgrep --config auto --error ."` (default: auto from package.json)
- `MAX_CYCLES` (8), `IDLE_MS` (4000), `BRIDGE_PORT` (5000), `DEV_URL`, `REV_URL`, `DEV_SESSION`
- `USE_COPILOT=1` adds Copilot CLI as a second reviewer (text, parsed into findings); `COPILOT_CMD`, `COPILOT_ARGS`

## Limits
- MCP cannot wake an idle agent; the bridge sends the prompts through the OpenCode session API.
- The developer AI relays your decision; `decisions.log` stores your exact words as an audit trail.
- AI review + scanners reduce risk but do not prove code secure. Also run the same checks in CI and have a human review auth/payment code.
- OpenCode config keys, tool names (`bridge_*`) and SDK calls are from memory of the docs; verify with `opencode mcp list` and adjust if your version differs.
