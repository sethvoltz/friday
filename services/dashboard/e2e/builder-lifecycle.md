# Builder lifecycle E2E (manual / on-demand)

End-to-end happy-path test for the full Builder lifecycle as driven through
the dashboard. Validates the new spawn chain (M2 sandbox-exec + M4 pgrp + M5
ulimit), workspace isolation, mail loop, and destroy/branch-delete (PF-2).

This is **not** a CI test. It runs a real Claude turn (cost), modifies real
state in `~/.friday/`, and depends on the user being logged in. Run manually
when validating substantial daemon changes that touch the spawn chain.

## Prereqs

- Daemon + dashboard running locally (`pnpm --filter @friday/daemon dev`,
  `pnpm --filter @friday/dashboard dev`).
- Logged-in browser session captured in `.playwright-mcp/`.
- `git -C agent-friday status --porcelain` baseline recorded (the test must
  finish with this set unchanged).
- Anthropic API credentials present in `~/.friday/.env`.

## Cost / time

- ~$0.20–$0.80 in Anthropic API charges per run (Opus 4.7, ~3 builder turns +
  orchestrator overhead).
- ~3–5 minutes wall-clock including the model's thinking time. Add 60s if the
  daemon needs to (re)start.

## Flow

| # | Actor      | Step                                                                    |
| - | ---------- | ----------------------------------------------------------------------- |
| 1 | Playwright | Navigate dashboard, find orchestrator chat input.                       |
| 2 | Playwright | Type spawn prompt (see below). Submit.                                  |
| 3 | Wait       | Up to 90s for `agent_create` MCP tool call + builder spawn.             |
| 4 | Bash       | Assertions A: worktree created, marker file, profile file, branch.     |
| 5 | Wait       | Builder runs `ls docs/`, mails orchestrator. Orchestrator surfaces.    |
| 6 | Bash       | Assertions D: parent repo `git status --porcelain` matches baseline.    |
| 7 | Playwright | Type "wrap up". Submit. Orchestrator calls `agent_kill` + asks confirm. |
| 8 | Playwright | Type "yes — delete it". Orchestrator calls `agent_delete_workspace`.   |
| 9 | Bash       | Assertions F: worktree gone, branch deleted (PF-2), profile cleaned.   |

## Spawn prompt

```
Spin up a builder named friday-e2e-probe against this repo. Default
settings — friday/friday-e2e-probe branch off main is fine. Task:
`ls docs/` inside its worktree and mail me the output. When I say
"wrap up" later, kill it and (after asking me to confirm) delete the
workspace. No need for a plan — proceed directly.
```

## Bash assertion blocks

### A — Workspace created

```bash
WORKTREE=~/.friday/workspaces/friday-e2e-probe
test -d "$WORKTREE"                                         # exists
git -C "$WORKTREE" rev-parse --show-toplevel                 # canonical path
test "$(git -C "$WORKTREE" branch --show-current)" \
  = "friday/friday-e2e-probe"                                # right branch
test -f "$WORKTREE/.friday-workspace.json"                   # marker
test -f ~/.friday/profiles/friday-e2e-probe.sb               # SBPL profile
```

### D — Parent repo unaffected

Capture baseline before step 1:
```bash
BASELINE=$(git -C /Users/seth/Development/Seth/Friday/agent-friday \
  status --porcelain | wc -l)
```

After step 6:
```bash
AFTER=$(git -C /Users/seth/Development/Seth/Friday/agent-friday \
  status --porcelain | wc -l)
test "$AFTER" = "$BASELINE"
find /Users/seth/Development/Seth/Friday/agent-friday/services \
  -type f -mmin -5 ! -path '*/node_modules/*' ! -path '*/dist/*' \
  ! -path '*/.svelte-kit/*'                                  # empty
```

### F — Destroy + cleanup

```bash
test ! -d ~/.friday/workspaces/friday-e2e-probe              # gone
test ! -f ~/.friday/profiles/friday-e2e-probe.sb             # M2 cleanup
git -C /Users/seth/Development/Seth/Friday/agent-friday \
  branch | grep -v "friday/friday-e2e-probe"                 # PF-2 deleted
git -C /Users/seth/Development/Seth/Friday/agent-friday \
  worktree list | grep -v friday-e2e-probe                   # gitref gone
pgrep -af friday-e2e-probe; test $? -ne 0                    # no orphans
```

## Known quirks observed during first run

1. **Two-step kill needed for destroy.** When the orchestrator calls
   `agent_kill` followed by `agent_delete_workspace`, the first kill is
   *graceful* — it sends a `stop` IPC and waits for the worker to exit.
   The agent status doesn't flip from `idle`→`killed` instantly. If
   `agent_delete_workspace` arrives before the worker exits, the API
   returns `409 agent friday-e2e-probe is idle; kill it before deleting`.
   The orchestrator handled this in our run by retrying after re-checking
   status. **Worth tightening at some point** — either have `agent_kill`
   return synchronously after status=killed, or have `agent_delete_workspace`
   wait/poll briefly.

2. **Destroyed Builder disappears from sidebar.** Once `agent_delete_workspace`
   succeeds, the Builder is gone from the active list AND doesn't appear in
   any "history" section — even with "Show killed" checked. Killed helpers
   and bare agents DO show up. Either the sidebar filters builders by
   worktreePath existence (intentional product decision: a builder without
   a workspace isn't a builder anymore), or it's a gap. Confirm before
   pinning as an assertion.

3. **`process.execArgv` must be forwarded.** When the spawn chain became
   `bash -c '...; exec node ...'` instead of `fork()`, the inner `node`
   started without the parent's loader hooks (tsx-watch's `--import`
   loader). Result: `Cannot find module '.../worker.js'` because tsx wasn't
   resolving `.js`→`.ts`. Fixed in `lifecycle.ts` by including
   `...process.execArgv` in the bash positional args. Regression-tested by
   `lifecycle-spawn-ipc.test.ts`.

## What the run *doesn't* verify

- The SBPL profile actually denies writes to `~/.ssh` etc. — covered by
  `sandbox-profile-kernel.test.ts` (vitest, real `sandbox-exec`).
- Process group containment of `disown`'d descendants — covered by
  `lifecycle-pgrp.test.ts`.
- `disaster-patterns.ts` rule coverage — covered by the 76-case vitest
  table in `disaster-patterns.test.ts`.
- The Builder's worker actually runs *under* the sandbox-exec wrap. The
  spawn argv is the right shape (verified by the profile file existing
  while the worker is alive), but proving the kernel sandbox is applied
  to that specific PID requires `sandbox_check` syscall inspection that
  `lsof`/`ps` don't expose. Trust the wiring; the unit tests cover the
  shape.

## Re-running

After a successful run, the only artifacts left in the parent repo are
`.playwright-mcp/` (screenshots and traces). Nothing in `~/.friday/`
belongs to the test. Safe to re-run immediately.
