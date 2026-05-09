# Friday Setup

This guide covers installation, account setup, and exposing Friday publicly via Cloudflare Tunnel.

## 1. Prerequisites

```bash
# macOS — install system dependencies
brew bundle --file=Brewfile
```

The Brewfile installs:

- `claude-code` — Claude Code CLI (Anthropic's official) — required, runs the Agent SDK
- `gh` — GitHub CLI for builders
- `tmux` — daemon + dashboard supervision
- `cloudflared` — Cloudflare Tunnel client

## 2. Install dependencies

```bash
pnpm install
pnpm build
```

## 3. First-time account setup

Friday has no public sign-up. The single primary account is created locally:

```bash
friday setup
```

This walks you through:
1. Creating `~/.friday/` directory tree.
2. Initializing the SQLite database and applying migrations.
3. Copying the default `SOUL.md` into `~/.friday/SOUL.md` (your editable identity layer).
4. Creating the primary user account (email + password).

You can re-run `friday setup` anytime — it's idempotent. Use `friday setup --reset-password` to change the password without touching anything else.

## 4. Health check

```bash
friday doctor
```

Verifies the data dir, config, db migrations, account presence, and external CLIs.

## 5. Run

```bash
friday start          # production mode (requires `pnpm build` first)
friday start --dev    # dev mode with hot reload (tsx watch + vite dev)
```

This starts the daemon and dashboard inside a tmux session named `friday`.

```bash
friday status         # show pids, ports, uptime
friday attach         # attach to the tmux session
friday logs --follow  # tail daemon log
friday stop           # shut everything down
```

By default:
- Daemon listens on `127.0.0.1:7444` (localhost only).
- Dashboard listens on `127.0.0.1:5173`.

Open `http://localhost:5173` and sign in with the credentials you set in step 3.

## 6. Public access via Cloudflare Tunnel

Friday is designed to be reachable from your phone or any browser via a Cloudflare hostname while still running on your laptop.

### One-time tunnel setup

```bash
# Authenticate cloudflared with your Cloudflare account
cloudflared tunnel login

# Create a named tunnel — pick a name like "friday"
cloudflared tunnel create friday

# Note the Tunnel ID printed; you'll reference it below.
```

### Configure the tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <YOUR_TUNNEL_ID>
credentials-file: /Users/<you>/.cloudflared/<YOUR_TUNNEL_ID>.json

ingress:
  - hostname: friday.<your-domain>.com
    service: http://127.0.0.1:5173
  - service: http_status:404
```

Replace `<YOUR_TUNNEL_ID>` with the id from `cloudflared tunnel create`, and pick a hostname under a domain you have on Cloudflare.

### Route the hostname

```bash
cloudflared tunnel route dns friday friday.<your-domain>.com
```

### Run the tunnel

```bash
cloudflared tunnel run friday
```

You can run this in a separate tmux window or as a launchd service. Once it's up, browsing to `https://friday.<your-domain>.com` will hit your local dashboard through the tunnel.

### Important: dashboard listens on localhost

The dashboard binds to `127.0.0.1`. The tunnel forwards public traffic to that local address. The daemon never sees the public internet — only the dashboard, gated by BetterAuth.

### Verify

1. Open the public hostname in a private browser window.
2. You should see the sign-in page.
3. Sign in with your account; you should land on the chat home.
4. Test from your phone over cellular — same flow.

### Optional hardening (not v1)

- **Cloudflare Access** at the edge for an additional auth layer (Google SSO, magic link, etc.). Layer it in front of the tunnel hostname via Cloudflare Zero Trust dashboard.
- **Rate limiting** on `/api/auth/sign-in/*`.
- **Cloudflare Bot Management.**

## 7. Configuration

Edit `~/.friday/config.json` to:

- Change the model (`"model": "claude-opus-4-7"`).
- Adjust ports (`daemonPort`, `dashboardPort`).
- Add MCP servers under `mcpServers`.

Edit `~/.friday/SOUL.md` to customize Friday's voice and identity. Source upgrades never overwrite this file.

## 8. Troubleshooting

| Symptom | Try |
|---|---|
| Login page won't accept credentials | `friday setup --reset-password` |
| Daemon won't start | `friday doctor`; check `~/.friday/logs/daemon.jsonl` |
| Dashboard shows "daemon not reachable" | Confirm daemon is running: `friday status` |
| Tunnel won't connect | `cloudflared tunnel info friday` |
| SSE drops on phone | Check Cloudflare Tunnel timeout; the daemon sends keepalives every 20s |
