# Running Friday

## Daily commands

| Command | What it does |
|---|---|
| `friday start` | Launch daemon + dashboard + zero-cache via tmux (always prod). For dev hot-reload, use `pnpm dev:daemon` / `pnpm dev:dashboard` instead — see "Dev mode" below. |
| `friday stop` | Kill the tmux session. |
| `friday restart <daemon\|dashboard\|zero-cache\|tunnel\|all>` | Restart a service (or `all`). Target is required — bare `friday restart` errors with usage. |
| `friday status` | Show pids, ports, uptime. |
| `friday doctor` | Health check. |
| `friday logs [daemon\|dashboard] [--follow]` | Tail logs. |
| `friday attach [daemon\|dashboard]` | Attach the tmux pane. |

## Inspection (read-only; daemon doesn't need to be running)

| Command | What it does |
|---|---|
| `friday agents ls` | List agents. |
| `friday sessions ls` | List sessions. |
| `friday memory ls` / `show <id>` | Read memory entries. |
| `friday tickets ls` / `show <id>` | Read tickets. |
| `friday mail inbox <agent>` | Read pending mail. |

## Mutations (require daemon running)

| Command | What it does |
|---|---|
| `friday agents archive <name>` | Archive an agent. For builders this also removes the worktree and force-deletes the `friday/<name>` branch. |
| `friday tickets create --title ... --body ...` | Create a ticket. |
| `friday tickets update <id> --status ...` | Update status. |
| `friday tickets comment <id> --author --body` | Add a comment. |
| `friday mail send --from --to --type --body` | Send mail. |
| `friday app install <path> [--adopt]` | Install a Friday App from a folder (FRI-78, ADR-021). |
| `friday app uninstall <id> [--folder=archive\|keep\|delete] [--yes]` | Uninstall. `--folder=delete` is irreversible and prompts unless `--yes`. |
| `friday app list` / `friday app inspect <id>` | Read-only inspection. |
| `friday app reload <id>` | Re-read the manifest from disk and reconcile. |

## Production (the only thing `friday` launches)

`friday start` runs the built artifacts: `node dist/index.js` for the daemon (binds **127.0.0.1:7610**), `node server-entry.mjs` for the dashboard (binds **127.0.0.1:7615** — a custom adapter-node wrapper that adds the `/api/sync` WS reverse-proxy to zero-cache), and `pnpm exec zero-cache` for the Zero sidecar (**127.0.0.1:4848**, internal-only behind the dashboard's WS proxy). Run `pnpm build` first; `friday start` rebuilds `packages/**` and the dashboard automatically before launch but won't pre-build raw source for you.

Ports default to the prod constants above. Override either via `~/.friday/config.json`'s `daemonPort` / `dashboardPort` (both optional). Zero-cache's port is fixed at 4848 (Zero's convention; if you need a parallel instance later, override via `ZERO_PORT` env at spawn time).

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
├── .env                   Secrets (DATABASE_URL, ZERO_AUTH_SECRET, LINEAR_API_KEY, etc.)
├── config.json            Settings + MCP server config
├── SOUL.md                Your editable identity layer
├── skills/*.md            User-additive slash skills
├── uploads/<bucket>/      Content-addressed attachments
├── memory/entries/*.md    Memory entries (mirrored to memory_entries Postgres table)
├── evolve/proposals/*.md  Evolve proposals
├── apps/<id>/             Installed Friday Apps (ADR-021)
├── schedules/             Scheduled-agent worktrees
├── workspaces/<name>/     Builder git worktrees
├── backups/<ts>.tar.gz    Output of `friday backup` (gitignored)
├── zero/replica.db        zero-cache's local replica (rebuilt from PG logical replication)
├── logs/{daemon,dashboard,zero-cache}.jsonl   Structured logs (rotated at 1 MiB)
├── usage.jsonl            Per-turn usage records
└── health.json            Daemon heartbeat (refreshed every 30s)
```

Canonical persistence lives in the **`friday` Postgres database** (host-managed via `brew services start postgresql@18`), not `~/.friday/`. The directory above carries config, secrets, and content-addressed file blobs; everything else (agents, blocks, tickets, mail, memory, schedules, apps, settings, read-cursors, client-devices) is in Postgres. See `docs/architecture.md` and ADR-023 for the topology.

Override the location with `FRIDAY_DATA_DIR=$HOME/.friday-v2 friday start`.

## Runtime env vars

Knobs that don't live in `config.toml`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FRIDAY_DATA_DIR` | `~/.friday` | Override the data directory root. |
| `FRIDAY_TURN_STALL_MS` | `1800000` (30 min) | Stall watchdog threshold — a working worker with no `block-stop` for longer than this gets pgrp-SIGTERMed. |
| `FRIDAY_TURN_STALE_CEILING_MS` | `14400000` (4 h) | Hard ceiling on a single turn (FRI-33). Any inbound IPC from a worker whose `turnStart` is older than this triggers a force-kill via `forceKillStuckWorker(reason: "stale")`. Defense against turns that stay alive past any plausible runtime (12.5h has been observed). |

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
