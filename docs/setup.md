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

Friday manages the tunnel for you. You provide one connector token; `friday start` runs `cloudflared` alongside the daemon and dashboard, and `friday stop` tears it down.

### Create the tunnel in Cloudflare

1. Cloudflare Zero Trust dashboard → **Networks → Connectors → Create a tunnel**.
2. Pick the **Cloudflared** connector, name it `friday`, and copy the **connector token** shown on the install screen.
3. Under **Public Hostname**, add a route: `friday.<your-domain>.com` → `http://127.0.0.1:5173`.

### Configure Friday

```bash
friday setup --cloudflare
```

Paste the token and your public URL (e.g. `https://friday.example.com`). The token is written to `~/.friday/.env` as `CLOUDFLARE_TUNNEL_TOKEN`; the public URL is stored in `~/.friday/config.json` for display.

### Run

`friday start` brings the tunnel up automatically when a token is present:

```bash
friday start          # daemon + dashboard + tunnel
friday status         # shows the public URL when the tunnel is up
friday logs tunnel -f # tail cloudflared output
friday stop           # tears all three down
```

If `cloudflared` is missing from `PATH` or the token is unset, the tunnel is skipped with a one-line note and the daemon + dashboard still come up. `friday doctor` surfaces both conditions.

### Important: dashboard listens on localhost

The dashboard binds to `127.0.0.1`. The tunnel forwards public traffic to that local address. The daemon never sees the public internet — only the dashboard, gated by BetterAuth.

### Verify

1. Open the public hostname in a private browser window — you should see the sign-in page.
2. Sign in with your account; you should land on the chat home.
3. Test from your phone over cellular — same flow.

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
| Tunnel won't connect | `friday doctor` then `friday logs tunnel -f` |
| SSE drops on phone | Check Cloudflare Tunnel timeout; the daemon sends keepalives every 20s |
