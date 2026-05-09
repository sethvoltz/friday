# Friday

Local-first AI orchestrator with a mobile-first dashboard, exposed publicly via Cloudflare Tunnel.

```bash
brew bundle --file=Brewfile
pnpm install
friday setup            # creates ~/.friday/, sets up account + initial config
friday start --dev      # daemon + dashboard via tmux
```

Open http://localhost:5173 (dev) or your Cloudflare hostname (production).

See `docs/setup.md` for full setup including Cloudflare Tunnel.
