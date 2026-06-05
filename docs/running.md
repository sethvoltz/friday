# Running Friday

## Daily commands

| Command                                         | What it does                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `friday start`                                  | Bootstraps (or kickstarts, if already loaded) the `com.sethvoltz.friday` launchd job via `launchctl` — no `brew services` (ADR-034). The launchd plist runs `friday-supervisor`, which forks daemon + dashboard + zero-cache as children with proper process-group cascade-stop semantics (ADR-028). For dev hot-reload, use `pnpm dev:daemon` / `pnpm dev:dashboard` — see "Dev mode" below. |
| `friday stop`                                   | `launchctl bootout gui/<uid>/com.sethvoltz.friday`. launchd sends SIGTERM to the supervisor, which cascade-kills every child's process group — no zombie zero-cache workers (the FRI-83 failure mode this supervision rework closes).                                                                                                                                                         |
| `friday restart`                                | `launchctl kickstart -k gui/<uid>/com.sethvoltz.friday`. Single-service restarts (`friday restart daemon`) are not supported under launchd supervision — the supervisor owns the whole stack atomically. Per-service IPC is an explicit follow-up.                                                                                                                                            |
| `friday status`                                 | Show pids, ports, uptime.                                                                                                                                                                                                                                                                                                                                                                     |
| `friday doctor`                                 | Health check.                                                                                                                                                                                                                                                                                                                                                                                 |
| `friday logs [daemon\|dashboard] [--follow]`    | Tail logs.                                                                                                                                                                                                                                                                                                                                                                                    |
| `friday attach <daemon\|dashboard\|zero-cache>` | Interactive `tail -F ~/.friday/logs/<service>.jsonl`. Ctrl-C exits the tail; the underlying service is untouched.                                                                                                                                                                                                                                                                             |

## Inspection (read-only; daemon doesn't need to be running)

| Command                           | What it does         |
| --------------------------------- | -------------------- |
| `friday agents ls`                | List agents.         |
| `friday sessions ls`              | List sessions.       |
| `friday memory ls` / `show <id>`  | Read memory entries. |
| `friday tickets ls` / `show <id>` | Read tickets.        |
| `friday mail inbox <agent>`       | Read pending mail.   |

## Mutations (require daemon running)

| Command                                                              | What it does                                                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `friday agents archive <name>`                                       | Archive an agent. For builders this also removes the worktree and force-deletes the `friday/<name>` branch. |
| `friday tickets create --title ... --body ...`                       | Create a ticket.                                                                                            |
| `friday tickets update <id> --status ...`                            | Update status.                                                                                              |
| `friday tickets comment <id> --author --body`                        | Add a comment.                                                                                              |
| `friday mail send --from --to --type --body`                         | Send mail.                                                                                                  |
| `friday app install <path> [--adopt]`                                | Install a Friday App from a folder (FRI-78, ADR-021).                                                       |
| `friday app uninstall <id> [--folder=archive\|keep\|delete] [--yes]` | Uninstall. `--folder=delete` is irreversible and prompts unless `--yes`.                                    |
| `friday app list` / `friday app inspect <id>`                        | Read-only inspection.                                                                                       |
| `friday app reload <id>`                                             | Re-read the manifest from disk and reconcile.                                                               |

## Production (launchd-supervised, direct registration)

`friday start` bootstraps the launchd job via `launchctl bootstrap gui/<uid> <plist>` (or kickstarts it if already loaded) — not `brew services` (ADR-034). The launchd plist (`~/Library/LaunchAgents/com.sethvoltz.friday.plist`, written directly by the installer / CLI, not generated by any brew formula) launches `friday-supervisor` through `fnm exec` (so `process.execPath` inside the supervisor is the fnm-resolved pinned Node), which forks three children — each spawned via `process.execPath` (the pinned Node), never bare `node`/`pnpm`/`.bin` shims:

- **daemon** — `process.execPath dist/index.js` (from `services/daemon`), binds **127.0.0.1:7610**.
- **zero-cache** — `process.execPath` against `@rocicorp/zero`'s `out/zero/src/cli.js` (after running `zero-deploy-permissions` once via the same `process.execPath`), binds **127.0.0.1:4848** WebSocket. Internal-only behind the dashboard's `/api/sync` WS proxy. Spawning the cli.js directly bypasses the pnpm `.bin` shim's baked absolute `NODE_PATH`, which doesn't survive relocation into a versioned install dir.
- **dashboard** — `process.execPath server-entry.mjs` (custom adapter-node entry with the WS proxy), binds **127.0.0.1:7615**.

Each child is spawned with `detached: true` so its pid is its own process-group leader. The supervisor traps SIGTERM/SIGINT and signals each child's process group, catching grandchildren (zero-cache's worker pool, the daemon's worker forks) that would otherwise leak. KeepAlive on crash with exponential backoff; zero-cache exit code 14 (`AutoResetSignal`) is fast-restart. 5 crashes inside 60s → supervisor exits non-zero so launchd surfaces the failure.

Ports default to the prod constants. Override either via `~/.friday/config.json`'s `daemonPort` / `dashboardPort` (both optional). Zero-cache's port is fixed at 4848 (Zero's convention; if you need a parallel instance later, override via `ZERO_PORT` env at spawn time).

**RunAtLoad: true** — Friday's stack comes back automatically after Mac reboot/login, no manual `friday start`. Postgres is a separate brew service with its own RunAtLoad. The Cloudflare tunnel is installed by `friday setup --cloudflare` (`cloudflared service install <TOKEN>`) as a user launch agent at `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist`, also with RunAtLoad — it self-starts independently of Friday's supervisor.

**Logs:**

- Supervisor's own events: `~/.friday/logs/supervisor.jsonl` (spawn/exit/cascade-stop trace).
- Each child's stdout + stderr: `~/.friday/logs/{daemon,dashboard,zero-cache}.jsonl` (replacing what tmux pane scrollback used to carry).
- launchd's own job-level log: `~/.friday/logs/launchd.out.log` and `launchd.err.log` (the plist's `StandardOutPath` / `StandardErrorPath`, written directly by the plist — no longer under the brew prefix since Friday's job isn't brew-generated; ADR-034).

## Dev mode for contributors

Dev is launched directly from the repo with two pnpm scripts, **not** the `friday` CLI:

```bash
pnpm dev:daemon       # tsx watch src/index.ts — daemon on :7444
pnpm dev:dashboard    # vite dev --port 5173 — dashboard on :5173
```

Both wrappers set `FRIDAY_DAEMON_PORT=7444` so the dev dashboard's SvelteKit server-side fetches reach the dev daemon (`:7444`) rather than the prod daemon (`:7610`) when both are running concurrently.

By default, dev shares `~/.friday/` with prod — including the Postgres `friday` database and the running prod zero-cache. This is intentional: testing against live data is sometimes the point. **Co-running prod + dev daemons against the same Postgres DB will produce inconsistent writes** — either `friday stop` first, or use full isolation:

```bash
FRIDAY_DATA_DIR=$HOME/.friday-dev pnpm dev:daemon
FRIDAY_DATA_DIR=$HOME/.friday-dev pnpm dev:dashboard
```

For full DB-level isolation (separate Postgres database and a parallel zero-cache), additionally `CREATE DATABASE friday_dev` and point a parallel `~/.friday-dev/.env`'s `DATABASE_URL` at it; spawn a second zero-cache on a different `ZERO_PORT`. Not currently scripted — flagged for a follow-up ticket.

The `--dev` CLI flag was retired with FRI-83. `friday start --dev` now exits with citty's unknown-flag error.

## Data location

Everything lives at `~/.friday/`:

```
~/.friday/
├── .env                       Secrets (DATABASE_URL, ZERO_AUTH_SECRET, LINEAR_API_KEY, etc.)
├── .daemon-secret             HMAC secret for daemon-internal auth (0600 — packages/shared/src/daemon-secret.ts)
├── config.json                Settings + MCP server config
├── SOUL.md                    Your editable identity layer
├── skills/*.md                User-additive slash skills
├── agents/<name>/             Per-agent home — orchestrator/helper/scheduled cwd (ADR-029)
├── uploads/<bucket>/          Content-addressed attachments
├── memory/entries/*.md        Memory entries (mirrored to memory_entries Postgres table)
├── evolve/proposals/*.md      Evolve proposals
├── apps/<id>/                 Installed Friday Apps (ADR-021)
├── schedules/<name>/          Scheduled-agent state continuity (state.md + last-run.md)
├── workspaces/<name>/         Builder git worktrees
├── profiles/<name>.sb         Per-builder sandbox-exec SBPL profiles (0600 — see docs/sandbox.md, ADR-021)
├── backups/<ts>.tar.gz        Output of `friday backup` (gitignored)
├── state/                     Daemon runtime state (per-service start markers; ADR-028)
├── zero/replica.db            zero-cache's local replica (rebuilt from PG logical replication)
├── logs/{daemon,dashboard,zero-cache}.jsonl   Structured logs (rotated at 1 MiB)
├── usage.jsonl                Per-turn usage records
└── health.json                Daemon heartbeat (refreshed every 30s)
```

Friday's own repo is a memory like any other. Add it via the dashboard memory UI, via `friday memory add` (writes as `createdBy=user`), or by `curl POST /api/memory` with the `x-friday-caller-name` header set to the owning agent. Friday writes its own memories via the `memory_save` MCP tool. Same mechanism for any other repo or always-inject fact a builder/helper needs.

Canonical persistence lives in the **`friday` Postgres database** (host-managed via `brew services start postgresql@18`), not `~/.friday/`. The directory above carries config, secrets, and content-addressed file blobs; everything else (agents, blocks, tickets, mail, memory, schedules, apps, settings, read-cursors, client-devices) is in Postgres. See `docs/architecture.md` and ADR-023 for the topology.

Override the location with `FRIDAY_DATA_DIR=$HOME/.friday-v2 friday start`.

## Runtime env vars

Knobs that don't live in `config.toml`:

| Variable                         | Default                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FRIDAY_DATA_DIR`                | `~/.friday`                | Override the data directory root.                                                                                                                                                                                                                                                                                                                                                                                    |
| `FRIDAY_TURN_STALL_MS`           | `1800000` (30 min)         | Stall watchdog threshold — a working worker with no `block-stop` for longer than this gets pgrp-SIGTERMed.                                                                                                                                                                                                                                                                                                           |
| `FRIDAY_TURN_STALE_CEILING_MS`   | `14400000` (4 h)           | Hard ceiling on a single turn (FRI-33). Any inbound IPC from a worker whose `turnStart` is older than this triggers a force-kill via `forceKillStuckWorker(reason: "stale")`. Defense against turns that stay alive past any plausible runtime (12.5h has been observed).                                                                                                                                            |
| `FRIDAY_RESPAWN_MAX_ATTEMPTS`    | `3`                        | Anti-loop cap for FRI-154 force-kill respawn: after this many consecutive respawn-then-die cycles inside `FRIDAY_RESPAWN_WINDOW_MS`, the daemon dead-letters (emits `worker.force-kill.dead-letter`, marks pending mail rows with `meta_json.dead_letter`, stops respawning).                                                                                                                                        |
| `FRIDAY_RESPAWN_WINDOW_MS`       | `600000` (10 min)          | Rolling window for the anti-loop counter above. A streak that doesn't trip the cap inside this window resets — a long-lived agent that survived 2 respawns months ago won't dead-letter on the next unrelated death.                                                                                                                                                                                                 |
| `FRIDAY_RESPAWN_BACKOFF_BASE_MS` | `1000` (1 s)               | Initial delay for the FRI-154 respawn schedule. Subsequent attempts grow as `min(2^attempts * base, cap)`.                                                                                                                                                                                                                                                                                                           |
| `FRIDAY_RESPAWN_BACKOFF_CAP_MS`  | `30000` (30 s)             | Upper bound on the exponential backoff above.                                                                                                                                                                                                                                                                                                                                                                        |
| `POSTHOG_API_KEY`                | _(unset → off)_            | PostHog project API key (the public `phc_…` token). When unset, both the daemon's `posthog-node` client and the dashboard's `posthog-js` client construct with an empty key and silently no-op — analytics are strictly opt-in. The daemon emits business + exception events; the dashboard server passes the same key to the browser for product analytics, autocapture, session replay, and client error tracking. |
| `POSTHOG_HOST`                   | `https://us.i.posthog.com` | PostHog ingestion host. Override for EU cloud (`https://eu.i.posthog.com`) or a self-hosted instance. Read by both the daemon and the dashboard (server + browser).                                                                                                                                                                                                                                                  |

> PostHog vars live in `~/.friday/.env` like any other secret. Setting `POSTHOG_API_KEY` enables analytics across the whole stack on the next `friday start`; the dashboard server reads it (via `ensureFridayEnv`) and forwards it to the browser through the root layout load.

## Cutover from old Friday

If you're running the old Slack-based Friday alongside this:

```bash
# 1. Stop the old daemon (in its own repo)
# 2. Move its data aside
mv ~/.friday ~/.friday-old

# 3. Run new setup against a fresh ~/.friday
friday setup
friday start
```

The old `~/.friday-old/` is untouched and grep-friendly.
