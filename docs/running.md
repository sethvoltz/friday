# Running Friday

Friday is a well-behaved Unix daemon. It reads config from `~/.friday/`, writes structured JSONL logs to `~/.friday/logs/<service>.jsonl`, and handles SIGTERM/SIGINT for graceful shutdown.

Add `./bin` to your PATH, or invoke the shim directly.

## Service Management

`friday` runs each service in one of two modes:

- **prod** — Spawns the built artifact (`node services/<svc>/dist/index.js` for the daemon, `node services/<svc>/build/index.js` for the dashboard). Detached. Errors with the exact build command if the artifact is missing or stale relative to source.
- **dev** — Runs the dev script (tsx watch / vite dev) inside a per-service tmux session named `friday-<svc>`, with hot reload. Logs are still written to the same JSONL file.

```bash
friday start daemon                  # prod (default)
friday start daemon --dev            # dev (tmux + hot reload)
friday start all                     # both services in prod
friday start all --dev               # both services, each in its own tmux session

friday stop daemon                   # graceful: SIGTERM, 5s grace, SIGKILL fallback,
                                     # then tmux kill-session for dev
friday stop all

friday restart daemon                # mode-preserving: errors if --dev/--prod is
                                     # passed; switching modes requires stop + start

friday status                        # human-readable
friday status --json                 # machine-readable (the agent contract — see below)
friday status daemon --json
```

State for each service is recorded at `~/.friday/state/<service>.json` and is the source of truth for the CLI; agents and other consumers should query through `friday status --json` rather than reading the file directly.

### Attaching to a dev session

```bash
friday attach dashboard       # land in the tmux pane (Ctrl-b d to detach)
```

Errors if the service is not in dev mode. For prod, use `friday logs` instead.

### Logs

```bash
friday logs daemon            # last 50 lines, raw JSON
friday logs daemon -f         # follow (tail -f equivalent)
friday logs daemon --pretty   # colorized for human reading
friday logs daemon -n 200 -f  # last 200 lines, then follow
```

Logs always live at `~/.friday/logs/<service>.jsonl` regardless of mode. In dev, the same lines are also visible inside the tmux pane.

### `friday status --json` contract (the agent contract)

Stable shape that agents can rely on for "how is this service doing":

```json
{
  "service": "dashboard",
  "state": "running",                      // running | stopped | crashed | stale
  "mode": "dev",                            // "dev" | "prod" | null when stopped
  "pid": 12345,
  "tmuxSession": "friday-dashboard",        // null in prod
  "startedAt": "2026-05-01T15:23:11Z",
  "startCommand": ["friday", "start", "dashboard", "--dev"],
  "logPath": "/Users/seth/.friday/logs/dashboard.jsonl",
  "lastLogTs": "2026-05-01T15:24:02Z"       // null when log is empty/missing
}
```

States:
- `running` — pid is alive, and (in dev) the tmux pane is alive
- `crashed` — dev only: tmux session exists but pane is dead (post-mortem available via `friday attach`)
- `stale` — state file lingers but neither pid nor session can be confirmed; `friday stop` will clean it up
- `stopped` — no state file

When deciding whether a code change requires a hard restart:
- `mode === "dev"` → hot reload (vite HMR / tsx watch) covers TS source changes; no `friday restart` needed.
- Hard restart needed for: `package.json` changes, `.env` changes, drizzle migrations, vite config changes, anything that requires the process to re-read config at boot.

## Reset orchestrator session

```bash
friday stop daemon
friday reset-orchestrator
friday start daemon
```

Refuses to run while the daemon is alive.

## Production

### Direct

```bash
cd agent-friday && pnpm run build
friday start daemon                  # uses ~/.friday/config.json
```

### launchd (macOS)

Create `~/Library/LaunchAgents/com.friday.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.friday.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/agent-friday/services/friday/dist/index.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
        <key>FRIDAY_LOG_STDOUT</key>
        <string>off</string>
    </dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.friday.daemon.plist
launchctl unload ~/Library/LaunchAgents/com.friday.daemon.plist
```

### systemd (Linux)

Create `/etc/systemd/user/friday.service`:

```ini
[Unit]
Description=Friday Slack Bridge
After=network.target

[Service]
Type=simple
Environment=FRIDAY_LOG_STDOUT=off
ExecStart=/usr/bin/node /path/to/agent-friday/services/friday/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable friday
systemctl --user start friday
```

## Health check

The daemon writes `~/.friday/health.json` every 30 seconds:

```json
{
  "pid": 12345,
  "startedAt": "2026-04-22T18:00:00.000Z",
  "lastHeartbeat": "2026-04-22T18:05:30.000Z",
  "uptimeMs": 330000
}
```

`friday status` cross-checks this against the heartbeat freshness and reports `stale` if the daemon is hung.

## Logs (operational)

Two sinks per service:

1. **File** — `~/.friday/logs/<service>.jsonl`. Always written. Append-only (no rotation yet).
2. **Stdout** — controlled by `FRIDAY_LOG_STDOUT`:
   - `json` — emit JSONL to stdout/stderr (default in dev so the tmux pane shows live logs)
   - `off`  — file-only (default for prod, set automatically by `friday start`)

The CLI sets the env var when launching, so `friday start daemon` runs prod with `off` and `friday start daemon --dev` runs dev with `json`. If you launch the daemon directly outside the CLI, the `json` default applies.
