# Plan: Developer terminal + automatic Reviewer terminal (OpenCode)

## 1. Goal
You write code in Terminal 1. A second OpenCode terminal automatically tests and reviews every change (bugs, security, production readiness, tests). Issues appear in Terminal 1, where you decide **resolve** or **skip (reason)**. The loop repeats until checks pass and the reviewer says READY.

## 2. Architecture

```
Terminal 1  Developer (OpenCode :4096)  <--MCP /mcp/developer--+
                                                               +-- ONE Bridge (MCP server + orchestrator :5000)
Terminal 2  Reviewer  (OpenCode :4097)  <--MCP /mcp/reviewer---+        |
            read-only                                                    +-- gate: tests, lint, audit, scanners
                                                                         +-- .review/ (snapshots, findings, decisions)
```

- **Bridge** = single MCP server + orchestrator. Stores findings, watches the Developer, runs the gate, prompts the Reviewer, pushes findings into the Developer terminal.
- **Two OpenCode instances** on different ports: Developer can edit; Reviewer cannot (edit/write/patch/bash disabled).
- MCP is pull-based, so the bridge sends the "go review" / "go fix" prompts through OpenCode's session API.

## 3. Project structure

```
your-project/
├── bridge.mjs                  # MCP server + orchestrator (one process)
├── opencode.developer.json     # Developer config: bridge MCP /mcp/developer
├── opencode.reviewer.json      # Reviewer config: read-only, security rules, bridge MCP /mcp/reviewer
├── package.json                # scripts: bridge, dev, review
├── PLAN.md                     # this file
├── README.md                   # quick start
├── .review/                    # created automatically, git-ignored
│   ├── findings.json           # all findings + status + verdicts
│   ├── decisions.log           # your resolve/skip decisions in your own words
│   └── cycle-001/              # one frozen snapshot per review cycle
│       ├── changes.patch       # read-only diff
│       ├── gate.txt            # test / lint / security-scan output
│       ├── meta.json
│       └── files/              # full copies of changed files
└── (your application code, tests)
```

## 4. Workflow (one cycle)

| # | Step | Who |
|---|---|---|
| 1 | You ask for a feature or fix | You, Terminal 1 |
| 2 | Developer edits code, goes idle (+4 s quiet) | Developer |
| 3 | Collect Git changes; skip if empty, too large, or same as last review | Bridge |
| 4 | Run gate: tests, lint, `npm audit`, optional gitleaks / semgrep | Bridge |
| 5 | Freeze snapshot in `.review/cycle-NNN/` | Bridge |
| 6 | Review snapshot + gate output; `bridge_submit_finding` per issue; `bridge_submit_verdict` | Reviewer |
| 7 | Findings are sent into Terminal 1; Developer explains each and asks resolve or skip | Bridge, Developer |
| 8 | You answer, e.g. `resolve 1,3; skip 2 because test-only` | You, Terminal 1 |
| 9 | Decisions recorded with your words; resolved items fixed, tests added and run, `bridge_mark_fixed` | Developer |
| 10 | Developer goes idle, next cycle starts; reviewer verifies fixes, does not re-raise skipped items | Bridge |
| 11 | Stop when gate passes, no findings, verdict READY (or `MAX_CYCLES`) | Bridge |

## 5. Reviewer rules (in `opencode.reviewer.json`)
- **Security:** injection, missing authn/authz, hardcoded secrets, unsafe deserialization, path traversal, missing input validation, sensitive data in logs, vulnerable dependencies.
- **Correctness:** bugs, unhandled errors, null/edge cases, races, resource leaks.
- **Production readiness:** env-based config, no debug code, timeouts/retries, logging, safe migrations.
- **Tests:** new behavior needs tests including failure cases; failing gate = high severity.
- **Verdict:** READY only if no high/medium issues and the gate passed.

## 6. Setup

```bash
cd your-project                       # Git repo with >= 1 commit
cp /path/to/bridge/{bridge.mjs,package.json,opencode.developer.json,opencode.reviewer.json,PLAN.md} .
npm install
```

Run (start the bridge first):

| Console | Command |
|---|---|
| Bridge (side pane) | `GATE_CMDS="npm test;;npm run lint;;gitleaks detect --no-git;;semgrep --config auto --error ." npm run bridge` |
| Terminal 1 Developer | `npm run dev` |
| Terminal 2 Reviewer | `npm run review` |

If `opencode --port` is not supported on your version, use `dev:server` + `dev:tui` and `review:server` + `review:tui`.

Settings (env vars): `GATE_CMDS`, `MAX_CYCLES` (8), `IDLE_MS` (4000), `BRIDGE_PORT` (5000), `DEV_URL`, `REV_URL`, `DEV_SESSION`, `USE_COPILOT=1` (adds Copilot CLI as second reviewer), `COPILOT_CMD`, `COPILOT_ARGS`.

## 7. Rollout phases

1. **Prerequisites:** install and log in to OpenCode (and Copilot CLI if used); pick a small Git repo with a working `npm test`; install gitleaks / semgrep if wanted.
2. **Smoke test:** run `opencode mcp list` with each config and confirm the `bridge_*` tools are visible. Ask the Reviewer to edit a file; it must refuse.
3. **First cycle:** ask Terminal 1 for a small, deliberately risky change (e.g. SQL built from user input). Expect the logs `snapshot frozen` -> `finding #1 from reviewer` -> `sent to developer terminal`.
4. **Decision loop:** try one resolve and one skip. Check `.review/decisions.log` and that the next cycle verifies the fix and leaves the skip alone.
5. **Tune:** set `GATE_CMDS` for your stack, adjust reviewer rules to your project, set `MAX_CYCLES`.
6. **Production hardening:** run the same gate in CI (GitHub Actions) on every pull request; require a human review for auth, payments and data migrations; keep `.review/` out of Git.

## 8. Known risks and limits

| Risk | Mitigation |
|---|---|
| OpenCode event, session or config names differ by version (not tested against a live install) | Phase 2-3 checks; send the bridge log line that fails |
| Developer AI relays your decision and could record one you didn't give | `decisions.log` stores your exact words; spot-check it |
| Developer keeps editing after fixes, endless loop | Hash check, idle delay, `MAX_CYCLES` |
| AI reviewers miss issues or raise false ones | Tests + scanners + CI + human review of sensitive code |
| Large diffs skipped (> 400 KB) | Commit in smaller steps |
| "Fully secure" cannot be guaranteed by any AI review | Treat this as a strong extra safety net, not a replacement for security practice |

## 9. Verified so far
- Bridge MCP server: reviewer and developer see only their own tools; findings store, resolve, skip-needs-reason and mark-fixed work (tested with a real MCP client).
- Not yet verified: connection to a live OpenCode (idle detection, prompting each terminal, MCP config keys).

## 10. Possible next steps
- Show Copilot follow-up questions and a `status` view of open findings.
- Add a structured "re-review only changed files" mode for large projects.
- Add a CI workflow file mirroring the gate.
