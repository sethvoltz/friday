# Running Friday

Friday is a well-behaved Unix daemon. It reads config from `~/.friday/`, logs structured JSON to stdout, and handles SIGTERM/SIGINT for graceful shutdown. Any process manager can wrap it.

## Development

Add `./bin` to your PATH, or invoke the shim directly:

```bash
./bin/friday dev start              # All services (daemon + dashboard) via Turborepo
./bin/friday dev start daemon       # Daemon only (tsx watch, auto-reload)
./bin/friday dev start dashboard    # Dashboard only
```

The dashboard (optional) will be available at `http://localhost:5173`.

## Service Management

The `friday` CLI manages daemon and dashboard processes via PID tracking:

```bash
./bin/friday start                  # Start all services (detached)
./bin/friday start daemon           # Start daemon only
./bin/friday stop                   # Stop all services
./bin/friday restart daemon         # Restart a specific service
./bin/friday status                 # Check what's running
```

## Production

### Direct

```bash
cd agent-friday && pnpm run build
node services/friday/dist/index.js
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
    <key>StandardOutPath</key>
    <string>/tmp/friday.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/friday.error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.friday.daemon.plist
launchctl unload ~/Library/LaunchAgents/com.friday.daemon.plist
```

### pm2

```bash
pm2 start services/friday/dist/index.js --name friday
pm2 restart friday
pm2 logs friday
pm2 save   # Persist across reboots
```

### systemd (Linux)

Create `/etc/systemd/user/friday.service`:

```ini
[Unit]
Description=Friday Slack Bridge
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/agent-friday/services/friday/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable friday
systemctl --user start friday
journalctl --user -u friday -f   # Follow logs
```

## Health Check

The daemon writes `~/.friday/health.json` every 30 seconds:

```json
{
  "pid": 12345,
  "startedAt": "2026-04-22T18:00:00.000Z",
  "lastHeartbeat": "2026-04-22T18:05:30.000Z",
  "uptimeMs": 330000
}
```

The file is removed on clean shutdown. If the file exists but `lastHeartbeat` is stale (> 60s old), the daemon is likely hung. `./bin/friday status` checks this automatically.

## Logs

All logs are structured JSON to stdout:

```json
{"ts":"2026-04-22T18:00:00.000Z","level":"info","event":"friday_ready","pid":12345,"startupMs":1200}
{"ts":"2026-04-22T18:00:05.000Z","level":"info","event":"agent_response","channelId":"C0123","sessionId":"abc","turnNumber":1,"costUsd":0.02,"durationMs":3200}
```

Route with your process manager's log handling, or pipe to a file:

```bash
node services/friday/dist/index.js >> /var/log/friday.jsonl 2>&1
```
