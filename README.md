# OpenCode Developer + Reviewer bridge

```
Terminal 1  Developer (OpenCode, you chat here)  <--MCP /mcp/developer--+
                                                                         +-- Bridge (Node: MCP server + orchestrator)
Terminal 2  Reviewer  (OpenCode, read-only)      <--MCP /mcp/reviewer---+
```

## Flow

1. You ask the Developer to build something.
2. The bridge waits for a quiet tracked working-tree patch. It reads `git diff HEAD`, so both staged and unstaged changes trigger it.
3. The gate runs. The default is `npm test`, `npm run lint`, and `npm audit --audit-level=high`.
4. The bridge freezes `.review/cycle-NNN/` with the patch, changed files, gate output, and metadata.
5. The Reviewer receives the snapshot, the review rules, and previous findings. It submits findings with `bridge_submit_finding`, then a `bridge_submit_verdict` of `READY` or `NOT_READY`.
6. `READY` is accepted only when the gate passed and no medium/high/critical finding is still open or in progress. Otherwise the bridge logs the reason and continues.
7. The Developer receives the findings and any gate failure. You decide **resolve** or **skip (reason)**. The Developer records your decision with `bridge_record_decision`; a skip without a reason is rejected.
8. A resolve sets the finding to `in_progress`. After the fix is complete, `bridge_mark_fixed` sets it to `resolved`.
9. The next cycle asks the Reviewer to verify resolved items and not re-raise skipped items unless the recorded reason is clearly wrong.
10. The loop stops at a validated `READY` or after `MAX_CYCLES`.

## Permission model

| Role | Permissions |
|---|---|
| Reviewer | Read, glob, grep, question. Edit, write, patch, shell, and subagent are denied. `.env` reads require approval. |
| Developer | Edit, write, patch, shell, subagent, read, glob, grep, question. `.env` reads require approval. |

The MCP surface is role-separated:

| Endpoint | Tools |
|---|---|
| `/mcp/reviewer` | `bridge_submit_finding`, `bridge_submit_verdict`, `bridge_get_state` |
| `/mcp/developer` | `bridge_mark_fixed`, `bridge_record_decision`, `bridge_get_state` |

Cross-role tool calls are rejected. The old ambiguous `/mcp` endpoint returns `404`.

## Setup

```bash
# this repository is the bridge
npm install
```

To use the bridge from another project, copy `bridge/`, `package.json`, `opencode.developer.json`, and `opencode.reviewer.json` into that project and run `npm install` there. The project must be a Git repository with at least one commit.

## Run

| Console | Commands |
|---|---|
| A: Bridge | `npm run bridge` (start first) |
| B: Developer | `npm run dev` (or `dev:server` + `dev:tui`) |
| C: Reviewer | `npm run review` (or `review:server` + `review:tui`) |

Check that OpenCode loaded the bridge tools:

```bash
OPENCODE_CONFIG=./opencode.developer.json opencode mcp list
OPENCODE_CONFIG=./opencode.reviewer.json opencode mcp list
```

The Reviewer must see only the reviewer tools, and the Developer only the developer tools. Reload/restart the OpenCode servers after changing the MCP endpoints or permissions.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `GATE_CMDS` | `npm test;;npm run lint;;npm audit --audit-level=high` | Commands separated by `;;` |
| `MAX_CYCLES` | `8` | Per-process cycle budget |
| `IDLE_MS` | `4000` | Quiet window before freezing a patch |
| `BRIDGE_PORT` | `5000` | MCP server port |
| `DEV_URL` / `REV_URL` | `:4096` / `:4097` | OpenCode session APIs |
| `DEV_SESSION` / `REV_SESSION` | auto-discovered | Explicit session IDs |

`mcp-proxy.mjs` requires `BRIDGE_URL`; both OpenCode configs set the correct role endpoint.

## Tests, lint, and CI

```bash
npm test          # node --test
npm run lint      # eslint .
npm run gate      # tests + lint + npm audit --audit-level=high
```

The GitHub Actions workflow runs the same steps on Node 24 for pushes and pull requests.

## Limits

- Only tracked changes are reviewed. Untracked files require staging or `git add -N`.
- Identical patches are not reviewed twice.
- `.review/` is gitignored.
- MCP cannot wake an idle agent; the bridge sends prompts through the OpenCode session API.
- The “do not re-raise skipped findings” rule is prompt-enforced, not a hard gate.
- AI review and scanners reduce risk but do not prove code is secure. Run the same checks in CI and have a human review authentication and payment code.
- Copilot integration and automatic commits are deferred.
