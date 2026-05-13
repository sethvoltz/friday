# Running Friday

## Daily commands

| Command | What it does |
|---|---|
| `friday start [--dev]` | Launch daemon + dashboard via tmux. `--dev` enables hot reload. |
| `friday stop` | Kill the tmux session. |
| `friday restart <daemon\|dashboard\|tunnel\|all>` | Restart a service (or `all`). Target is required — bare `friday restart` errors with usage. Restarting `dashboard` or `all` in dev bounces vite, which triggers a full browser reload on reconnect; prefer `friday restart daemon` when only daemon state needs refreshing. |
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

## Modes

- **Production** (no flag): runs the built artifacts (`node dist/index.js` for the daemon, `node build/index.js` for the dashboard). Run `pnpm build` first.
- **Dev** (`--dev`): runs `tsx watch` for the daemon and `vite dev` for the dashboard. Hot reload, slower startup, expects source on disk.

## Data location

Everything lives at `~/.friday/`:

```
~/.friday/
├── db.sqlite              SQLite + WAL — the source of truth for app state
├── config.json            Settings + MCP server config
├── .env                   Secrets (LINEAR_API_KEY, etc.)
├── SOUL.md                Your editable identity layer
├── skills/*.md            User-additive slash skills
├── uploads/<bucket>/      Content-addressed attachments
├── memory/entries/*.md    Memory entries (mirrored to memory_entries table)
├── evolve/proposals/*.md  Evolve proposals
├── workspaces/<name>/     Builder git worktrees
├── logs/{daemon,dashboard}.jsonl   Structured logs (rotated at 1 MiB)
├── usage.jsonl            Per-turn usage records
└── health.json            Daemon heartbeat (refreshed every 30s)
```

Override the location with `FRIDAY_DATA_DIR=$HOME/.friday-v2 friday start`.

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
