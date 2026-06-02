# Friday prerequisites — install with:
#   brew bundle --file=Brewfile

cask "claude-code"     # Claude Code CLI — required, runs Agent SDK sessions
brew "gh"              # GitHub CLI — Builders use it for clone + PRs
brew "pnpm"            # pnpm — build/dev-time package manager (CI pack + contributor workflow; not on the runtime path)
brew "fnm"             # Fast Node Manager — resolves .node-version (22.21.1) for the launchd-supervised stack (ADR-033)
brew "cloudflared"     # Cloudflare Tunnel — public reachability for the dashboard
brew "postgresql@18"   # Postgres — Friday's canonical store (ADR-023). Start with: brew services start postgresql@18
