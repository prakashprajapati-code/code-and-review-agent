# Implementation Plan: Code Review Bridge

## Locked decisions

| Decision | Choice |
|---|---|
| Scope | All phases |
| `opencode.json` | Remove/rename |
| Review unit | Staged + unstaged tracked changes |
| Idle detection | Patch quiet window |
| MCP endpoints | Separate + filtered by role |
| Stop rule | Validated `READY` + `MAX_CYCLES` |
| Quality gate | `node:test` + ESLint + GitHub Actions |
| Copilot | Deferred |

**Assumption:** “Staged + unstaged” means tracked files via `git diff HEAD`. Untracked files are excluded unless they are staged or marked with `git add -N`. If untracked files should be picked up automatically, that needs an extra step.

---

## Phase 1 — Reviewer safety and config cleanup

**Outcome:** the reviewer is genuinely read-only, and passwords no longer appear in logs.

**Files:**
- `opencode.reviewer.json`
- `opencode.developer.json`
- `opencode.json`
- `bridge/bridge.mjs`

**Steps:**
1. Confirm the exact OpenCode v2 permission schema using `opencode debug config` and `/api/config`.
2. Replace the reviewer’s invalid `permissions` object with valid rule entries:
   - deny `edit`
   - deny `write`
   - deny `patch`
   - deny `bash`
   - allow `read`
   - allow MCP tool use
3. Give the developer explicit allow rules for `read`, `edit`, `write`, `patch`, and `bash`.
4. Remove ignored keys such as `rules`, `type`, `name`, and `id` from the role configs.
5. Move the untracked `opencode.json` out of config discovery:
   ```bash
   mv opencode.json /tmp/opencode.json.bak
   ```
6. Remove the two `console.log(this.revSessionClient)` / `console.log(this.devSessionClient)` calls that expose passwords. Log only `baseUrl`.
7. Restart the reviewer and developer servers.

**Verification:**
- `/api/config` on `:4097` shows the deny rules.
- Reviewer cannot edit, write, patch, or run bash.
- Developer can still edit.
- Bridge startup logs no passwords.

**Do not proceed until this passes.** It is the security boundary.

---

## Phase 2 — Reliable change detection

**Outcome:** any tracked working-tree change is detected, but the bridge waits for the patch to become quiet before reviewing.

**Files:**
- `bridge/git.js`
- `bridge/snapshot.js`
- `bridge/bridge.mjs`

**Steps:**
1. Replace staged-only reads with working-tree reads:
   - `getChangedNames()` → `git diff --name-only HEAD`
   - `getPatch()` → `git diff HEAD`
   - This includes both staged and unstaged tracked changes.
2. Hash the **patch content** using SHA-256, not file names.
3. Add a quiet-window loop:
   - poll every `min(1000, IDLE_MS)` ms
   - reset the quiet timer whenever the patch hash changes
   - freeze only when the hash has stayed unchanged for `IDLE_MS`
4. Skip when:
   - patch is empty
   - patch is larger than 400 KB
   - patch hash equals `lastReviewedHash`
5. After a successful freeze, set `lastReviewedHash`.
6. Log why a patch was skipped.
7. Update `SnapshotFreezer.freeze()` to accept the patch and changed file names, avoiding duplicate git calls.

**Verification:**
- Edit a tracked file without staging → review triggers.
- Stage a tracked file → review triggers.
- Change content again → new review triggers.
- Re-save identical content → no new review.
- Two rapid saves inside `IDLE_MS` → no review until the patch is stable.

---

## Phase 3 — Gate result, verdict validation, and stop conditions

**Outcome:** the loop stops only when the gate passes, no high/medium findings remain, and the reviewer says `READY`; `MAX_CYCLES` always stops it.

**Files:**
- `bridge/gate.js`
- `bridge/snapshot.js`
- `bridge/bridge.mjs`
- new: `bridge/policy.js`

**Steps:**
1. Change `GateRunner.run()` to return:
   ```js
   { output, ok, results: [{ cmd, ok, exitCode }] }
   ```
2. Pass `repoRoot` into `GateRunner` instead of relying on `process.cwd()`.
3. Store `gate_ok` and per-command results in `cycle-NNN/meta.json`.
4. Return `{ cycleName, gateOk }` from `SnapshotFreezer.freeze()`.
5. Add `MAX_CYCLES`, default `8`.
6. Add `bridge/policy.js` with pure functions:
   - `countOpenHighMedium(findings, cycle)`
   - `validateVerdict({ verdict, findings, gateOk })`
   - `shouldStop({ verdict, gateOk, findings, cyclesRun, maxCycles })`
7. On `READY`:
   - if gate failed or high/medium findings remain, log the reason and treat it as `NOT_READY`
   - if valid, log `validated READY` and break
8. On `MAX_CYCLES`, log `max cycles reached` and break.
9. If the gate failed but there are no findings, prompt the developer with the failing gate commands.

**Verification:**
- Unit tests for `validateVerdict` and `shouldStop`.
- `MAX_CYCLES=1` stops after one successful snapshot.
- `READY` with an open high finding does not stop.
- `READY` with a failed gate does not stop.

---

## Phase 4 — Reviewer context and decision loop

**Outcome:** the reviewer verifies fixes and does not re-raise skipped findings; decisions are recorded correctly.

**Files:**
- `bridge/bridge.mjs`
- `bridge/state.js`
- `bridge/mcp.js`
- new: `bridge/prompts.js`

**Steps:**
1. Add `bridge/prompts.js` with:
   - `REVIEWER_RULES` — security, correctness, production readiness, tests, verdict rule
   - `buildReviewerPrompt({ cycleName, gateOk, previousFindings })`
   - `buildDeveloperPrompt({ cycleName, findings, gateFailure })`
2. Move the ignored reviewer rules from `opencode.reviewer.json` into `REVIEWER_RULES`.
3. Include previous-cycle context in the reviewer prompt:
   - resolved findings
   - skipped findings and their reasons
   - still-open/in-progress findings
4. Instruct the reviewer:
   - verify resolved items
   - do not re-raise skipped items unless the reason is clearly wrong
   - call `bridge_get_state` if more detail is needed
   - submit findings before verdict
5. Fix finding status semantics:
   - `open` → finding submitted
   - `in_progress` → user chose resolve
   - `resolved` → `bridge_mark_fixed` called
   - `skipped` → user chose skip with reason
6. `bridge_record_decision`:
   - skip requires a reason
   - resolve sets `in_progress`, not `resolved`
7. `bridge_mark_fixed` sets `resolved`.
8. `waitForDecisions` checks that every current finding has a recorded decision, not that it is already fixed.
9. `bridge_submit_finding` rejects duplicate IDs within the same cycle.
10. `bridge_submit_verdict` rejects `READY` when high/medium findings are open; the bridge re-checks gate status.

**Verification:**
- One resolve and one skip produce correct `decisions.log` lines.
- Skip without reason is rejected.
- Next reviewer prompt contains resolved IDs and skip reasons.
- Skipped finding is not re-raised.
- Resolved finding remains `in_progress` until `bridge_mark_fixed`.

---

## Phase 5 — Role-separated MCP endpoints

**Outcome:** reviewer and developer each get only their own tools.

**Files:**
- `bridge/bridge.mjs`
- `bridge/mcp.js`
- `bridge/mcp-proxy.mjs`
- `opencode.developer.json`
- `opencode.reviewer.json`

**Steps:**
1. Route:
   - `/mcp/reviewer`
   - `/mcp/developer`
2. Return `404` for the old ambiguous `/mcp`.
3. Bind each MCP session to its role.
4. Tool access:
   - reviewer: `bridge_submit_finding`, `bridge_submit_verdict`, `bridge_get_state`
   - developer: `bridge_mark_fixed`, `bridge_record_decision`, `bridge_get_state`
5. Reject cross-role tool calls with a clear MCP error.
6. Update each config’s `BRIDGE_URL` to the correct path.
7. Export pure helpers `toolsForRole(role)` and `isToolAllowed(role, name)` for tests.

**Verification:**
- Reviewer endpoint lists exactly 3 tools.
- Developer endpoint lists exactly 3 tools.
- Reviewer cannot call `bridge_mark_fixed`.
- Developer cannot call `bridge_submit_finding`.
- Both can call `bridge_get_state`.

---

## Phase 6 — Tests, lint, and CI

**Outcome:** the gate is real and repeatable.

**Files:**
- `package.json`
- `eslint.config.js`
- `test/*.test.js`
- `.github/workflows/ci.yml`

**Steps:**
1. Add scripts:
   ```json
   "test": "node --test",
   "lint": "eslint .",
   "gate": "npm test && npm run lint && npm audit --audit-level=high"
   ```
2. Add dev dependencies:
   - `eslint`
   - `@eslint/js`
   - `globals`
3. Add tests:
   - `test/git.test.js` — staged, unstaged, same content, new content
   - `test/policy.test.js` — verdict validation and stop rules
   - `test/state.test.js` — resolve/skip status transitions, skip requires reason
   - `test/mcp.test.js` — role filtering, cross-role rejection, duplicate finding ID
   - `test/gate.test.js` — pass/fail result shape
   - `test/snapshot.test.js` — large diff rejection
   - `test/prompts.test.js` — previous findings and skip reasons included
4. Update default `GATE_CMDS`:
   ```bash
   npm test;;npm run lint;;npm audit --audit-level=high
   ```
5. Add `.github/workflows/ci.yml`:
   - trigger on push and pull request
   - Node 24
   - `npm ci`
   - `npm test`
   - `npm run lint`
   - `npm audit --audit-level=high`
6. Keep `.review/` gitignored.

**Verification:**
- `npm test` passes.
- `npm run lint` passes.
- `npm audit --audit-level=high` passes or has a documented exception.
- GitHub Actions is green.

---

## Phase 7 — End-to-end rollout and hardening

**Outcome:** one complete cycle, one decision loop, and a validated stop are proven.

**Files:**
- `README.md`
- optionally `PLAN.md`
- no new runtime code unless a defect is found

**Steps:**
1. Create a throwaway branch:
   ```bash
   git switch -c test/review-cycle
   ```
2. Start the bridge with explicit sessions:
   ```bash
   DEV_SESSION=<dev-id> REV_SESSION=<reviewer-id> npm run bridge
   ```
3. Make a deliberately risky tracked change.
4. Verify the sequence:
   ```text
   waiting for quiet patch
   snapshot frozen: cycle-001
   prompted reviewer: cycle-001
   finding #1 from reviewer
   pushed findings to developer: cycle-001
   all findings decided for cycle-001
   ```
5. Test one resolve:
   - fix the issue
   - call `bridge_mark_fixed`
   - verify the next cycle verifies it
6. Test one skip:
   - skip with a reason
   - verify `.review/decisions.log`
   - verify the next reviewer prompt does not re-raise it
7. Test gate failure:
   - intentionally fail a gate command
   - verify `READY` does not stop the loop
8. Test `MAX_CYCLES=1`.
9. Verify final stop:
   ```text
   validated READY: cycle-00N
   ```
10. Update `README.md` with:
    - new permission model
    - separate MCP endpoints
    - `MAX_CYCLES`
    - staged + unstaged behavior
    - untracked-file limitation
    - test/lint/CI commands
11. Delete the throwaway branch after the test.

**Verification / definition of done:**
- Reviewer cannot edit.
- Staged and unstaged tracked changes trigger.
- Identical patches do not retrigger.
- Quiet window prevents mid-edit reviews.
- Role tools are separated.
- Resolve and skip both work.
- Gate failure blocks `READY`.
- `MAX_CYCLES` stops the loop.
- `npm test`, `npm run lint`, and CI pass.
- No passwords in logs.

---

## Execution order

```text
1. Reviewer safety + config cleanup
2. Change detection
3. Gate + stop rules
4. Reviewer/developer loop + decisions
5. Role-separated MCP
6. Tests + lint + CI
7. End-to-end rollout + README
```

Phases 4 and 5 can run in parallel after Phase 2. Phase 6 should start right after Phase 3 so later phases are covered by tests.

## Deferred

- `USE_COPILOT`, `COPILOT_CMD`, `COPILOT_ARGS`
- a status dashboard
- automatic commits
- “re-review only changed files” mode
