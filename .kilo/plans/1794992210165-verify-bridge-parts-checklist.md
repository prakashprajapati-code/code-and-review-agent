# Verify which parts of code-Review-agent work (and how)

## Goal
Produce a repeatable check plan to determine what is working vs not in this repo (bridge/orchestrator, MCP, git/gate/snapshot/state/session, OpenCode integration), with minimal risk and no source edits.

## Scope (in)
- Static checks of repo files and code paths already present.
- Runtime checks: dependency/install sanity, start bridge, MCP proxy connectivity, OpenCode MCP visibility, end-to-end cycle smoke test (only if live OpenCode + git repo ready).
- Output: a short “working / partial / not verified / broken” table per component plus commands used.

## Out of scope
- Editing application source/non-plan docs beyond this plan (this plan only).
- Claiming security guarantees from AI review; only verifying tooling behavior.

## Preconditions
- CWD: `/home/naarvee/projects/test_project/code-Review-agent` (git repo).
- Node/npm installed; `node_modules/` present or run `npm install`.
- For runtime cycle tests: a git repo with >= 1 commit, staged/changed work to trigger review, and OpenCode installed/logged in if testing `dev`/`review` flows.

## How to check (method)
1. **Static (safe, read-only)**
   - Confirm file layout matches expected modules: `bridge/{bridge.mjs,mcp.js,mcp-proxy.mjs,gate.js,git.js,snapshot.js,state.js,session.js}`, root `opencode.developer.json`, `opencode.reviewer.json`, `opencode.json`, `package.json`, `README.md`, `PLAN (3).md`, `.gitignore`.
   - `node --check bridge/bridge.mjs bridge/mcp.js bridge/mcp-proxy.mjs bridge/gate.js bridge/git.js bridge/snapshot.js bridge/state.js bridge/session.js` (syntax/parse). If fails: broken/parse error.
   - Skim for known mismatches already identified (do not fix now): polling+git trigger vs “idle +4s” wording in docs; `MAX_CYCLES`/`DEV_SESSION`/Copilot envs documented but not implemented in code; MCP tools exposed to both configs (no role gate in MCP layer); `bridge_mark_fixed` records only `resolve <id>` in decisions log (no user words) vs `bridge_record_decision` captures words.
2. **Dependency/install sanity**
   - `npm ls --depth=0` (or `npm install` if missing). Expect `@modelcontextprotocol/sdk`, `@opencode-ai/sdk`, `dotenv`, `zod`, `concurrently` (dev). Missing install => not runnable.
3. **Bridge process (MCP HTTP + orchestrator loop)**
   - Start: `npm run bridge` (or `node ./bridge/bridge.mjs`) from repo root. Expect console: `MCP server listening on http://127.0.0.1:<BRIDGE_PORT>` (default 5000). If port in use or crash: note error.
   - Quick HTTP sanity (optional): `curl -sS http://127.0.0.1:5000/mcp` may not be a plain GET in Streamable HTTP mode; prefer MCP client/proxy test next.
4. **MCP proxy + tool exposure**
   - With bridge running, run: `node bridge/mcp-proxy.mjs` briefly? Or test via OpenCode: from repo root run `opencode mcp list` using the same env/config as configs (e.g. `OPENCODE_CONFIG=./opencode.developer.json opencode mcp list`). Expect tools: `bridge_submit_finding`, `bridge_submit_verdict`, `bridge_mark_fixed`, `bridge_record_decision`, `bridge_get_state` visible for the configured `bridge` server (via proxy to `BRIDGE_URL`). If proxy cannot connect => “bridge not running” or `BRIDGE_URL` wrong.
5. **Git/gate/snapshot/state behavior (unit-style, manual)**
   - Git: in a real git repo, stage a small change; verify `git diff --staged --name-only HEAD` produces lines (matches `GitWatcher` logic). Unstaged-only changes will not trigger current flow (by design: staged diff path).
   - Gate: set `GATE_CMDS` to a tiny command (e.g. `echo ok`) and run a freeze path mentally or via a throwaway script idea — but do not edit code; document expected files under `.review/cycle-001/` after a successful orchestrator cycle: `changes.patch`, `gate.txt`, `meta.json`, `files/`.
   - State: after using MCP tools (or after a cycle), inspect `.review/findings.json`, `.review/verdict.json`, `.review/decisions.log` (all gitignored). Confirm shapes roughly match `StateManager` (findings array with status/decided_at/decision_reason fields as written).
6. **OpenCode session integration (live)**
   - Start in order: bridge first (`npm run bridge`), then developer server (`npm run dev`), then reviewer (`npm run review`) (or split server/tui as in README). Confirm bridge logs show session discovery attempts (`discoverSessions`) or warnings if none.
   - Trigger: stage a change in git (and ensure tool flow matches `GitWatcher.hasNewDiff` using staged name hash). Wait `IDLE_MS`+poll behavior. Expect: snapshot frozen log, prompt sent logs to reviewer/dev if sessions found, then polling for verdict/decisions timeouts if no MCP calls made — document whether cycle completes or stalls.
7. **End-to-end smoke (only if ready)**
   - Deliberately risky small change staged => reviewer submits findings via `bridge_submit_finding` + `bridge_submit_verdict` (NOT_READY) => bridge pushes findings prompt to dev session => dev calls `bridge_record_decision`/`bridge_mark_fixed` as per workflow => next cycle behavior observed. Record what happened vs §4 of `PLAN (3).md`.

## Checklist table (fill during checks)
- `bridge/bridge.mjs` (start, HTTP listen, loop, session discovery): …
- `bridge/mcp.js` + `bridge/mcp-proxy.mjs` (tools listed, calls forwarded): …
- `bridge/git.js` (staged diff/hash, triggers only on staged): …
- `bridge/gate.js` (splits `;;`, captures output): …
- `bridge/snapshot.js` (freeze, size limit, files copy): …
- `bridge/state.js` (findings/verdict/decisions files): …
- `bridge/session.js` + OpenCode API calls: …
- Configs `opencode.developer.json` / `opencode.reviewer.json` / `opencode.json` (MCP wiring, permissions/rules present): …
- Scripts `package.json` (`bridge/dev/review/*`): …

## Known gaps to call out (from current repo inspection)
- No `MAX_CYCLES` enforcement; loop runs until process stops.
- Trigger is staged-diff polling/dedup (not true OpenCode “idle event + 4s quiet” as written in plan text).
- Same MCP tool set exposed to both developer and reviewer clients (no role-based filtering in MCP server).
- `bridge_mark_fixed` appends `resolve <id>` to decisions log without user words; `bridge_record_decision` is the path for words/reasons.
- Copilot/`DEV_SESSION`/some README envs mentioned elsewhere not implemented in code (verify docs vs code when testing).
- “READY” currently logged and loop continues (no explicit stop-on-success policy beyond log) — confirm desired behavior.

## Validation / done criteria for this plan
- Table filled with evidence (commands run + observed output snippets summarized) for at least: static `node --check`, bridge start, `opencode mcp list` for one config, and one of (git/snapshot/state manual check OR live cycle note).
- Any “not verified” items listed explicitly (needs live OpenCode / needs staged changes / needs specific env).

## Risks / notes
- Streamable HTTP MCP endpoint behavior can vary by SDK version; prefer OpenCode MCP listing/proxy path as practical verification.
- AI prompts/actions in live OpenCode are non-deterministic; verify mechanics (files written, logs, tool calls) not LLM quality.
- Do not commit `.review/` artifacts or secrets from `.env`.