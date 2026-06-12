# Friday Setup

This guide covers installation, account setup, and exposing Friday publicly via Cloudflare Tunnel.

## 1. Prerequisites

```bash
# macOS — install system dependencies
brew bundle --file=Brewfile
```

The Brewfile installs:

- `gh` — GitHub CLI for builders
- `fnm` — Fast Node Manager; resolves the pinned Node from `.node-version` (`22.21.1`) and is how the launchd-supervised stack launches Node (ADR-034)
- `pnpm` — build/dev-time package manager (CI pack + contributor builds); not on Friday's runtime path
- `cloudflared` — Cloudflare Tunnel client (optional, for public reachability)

> **Required: wire fnm into your shell.** `brew install fnm` does **not** put `node` on your interactive PATH — you must add fnm's shell hook to your shell rc and open a new terminal:
>
> ```bash
> echo 'eval "$(fnm env)"' >> ~/.zshrc   # then open a NEW terminal
> ```
>
> This is easy to miss because fnm's Homebrew formula prints no caveat (the curl installer surfaces it for you, and `friday doctor` flags it). It is **not optional**: Friday's agent workers spawn `$SHELL -ilc` and run a `node` marker to capture your environment, so without node on the interactive PATH **every agent turn silently completes with no reply** — the daemon looks healthy, messages send, but Friday never responds.

Install **Claude Code** separately — the brew cask shadows Anthropic's own installer, so the Brewfile leaves it to you:

```bash
# Anthropic's official installer
curl -fsSL https://claude.ai/install.sh | bash
# …or via brew
brew install --cask claude-code
```

See [docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code). `friday doctor` verifies `which claude` regardless of install method.

`tmux` is no longer required — Friday's prod supervision moved to launchd, with the plist written directly by the installer (ADR-028, ADR-034). Contributors who want it for the dev workflow can `brew install tmux` separately.

## 2. Install Friday

```bash
curl -fsSL https://raw.githubusercontent.com/sethvoltz/friday/main/install.sh | bash
```

Downloads the latest **pre-baked release tarball** for your Mac's architecture — `friday-darwin-arm64.tar.gz` on Apple Silicon, `friday-darwin-x64.tar.gz` on Intel (the installer selects it from `uname -m`) — verifies its `shasum -a 256` against the published `.sha256`, ensures the pinned Node via `fnm install` (reading `.node-version`, default `22.21.1`), extracts to `~/.local/share/friday/versions/<version>/`, flips the `~/.local/share/friday/current` symlink, writes a `~/.local/bin/friday` PATH shim, and writes + bootstraps the launchd plist (`com.sethvoltz.friday`) that supervises the prod stack — all directly, no `brew services` (ADR-034).

Install finishes in seconds: there is no on-device `pnpm install`/`pnpm -r build` (the tarball ships `node_modules` pre-baked, ABI-matched to the fnm-pinned Node). Re-running the installer updates in place, as does `friday update` (`friday update --check` reports the delta, `friday update --rollback` flips back to the prior version). macOS only — Apple Silicon (arm64) is the primary target, Intel (x64) is legacy support; Postgres + cloudflared stay brew-managed via `brew bundle`.

**For contributors who want to source-edit:** clone the repo and use the dev workflow instead — see [Developing Friday](../README.md#developing) in the README. The dev workflow doesn't need the release tarball.

## 3. First-time account setup

Friday has no public sign-up. The single primary account is created locally:

```bash
friday setup
```

This walks you through:

1. Creating `~/.friday/` directory tree.
2. Provisioning the Postgres `friday` role + database, applying Drizzle migrations, and creating the `friday_pub` publication for zero-cache's logical replication (ADR-023). Connection details are written to `~/.friday/.env.local`.
3. Copying the default `SOUL.md` into `~/.friday/SOUL.md` (your editable identity layer).
4. Creating the primary user account (email + password).

You can re-run `friday setup` anytime — it's idempotent. Use `friday setup --reset-password` to change the password without touching anything else.

## 4. Health check

```bash
friday doctor
```

Verifies the data dir, config, db migrations, account presence, external CLIs, and — critically — that `node` resolves in your **interactive shell** (`$SHELL -ilc`), the context agent workers run in. A failing `node in shell` row is the tell-tale for "daemon healthy but Friday never replies" (the fnm shell hook above is missing).

## 5. Run

```bash
friday start          # bootstrap/kickstart the launchd job (com.sethvoltz.friday)
```

The launchd plist runs `friday-supervisor` (through `fnm exec`) which forks daemon + dashboard + zero-cache as children with proper process-group cascade-stop (ADR-028). The plist is written + bootstrapped directly by the installer / CLI (`launchctl bootstrap`/`kickstart`), not `brew services` (ADR-034). `RunAtLoad: true` means Friday comes back automatically after Mac reboot/login.

For dev hot-reload, use `pnpm dev:daemon` / `pnpm dev:dashboard` (see `docs/running.md`) — they don't touch the launchd-supervised stack.

```bash
friday status         # supervisor + service state + probed ports
friday attach daemon  # tail ~/.friday/logs/daemon.jsonl (Ctrl-C exits)
friday logs --follow  # tail daemon log
friday stop           # shut the stack down (cascade-stops every child)
```

By default:

- Daemon listens on `127.0.0.1:7610` (localhost only).
- Dashboard listens on `127.0.0.1:7615` ("TGIF").
- Zero-cache listens on `127.0.0.1:4848` (internal-only behind the dashboard's `/api/sync` WS proxy).

Open `http://localhost:7615` and sign in with the credentials you set in step 3.

## 6. Public access via Cloudflare Tunnel

`friday setup --cloudflare` handles the persistence end-to-end: it saves the token to the age-encrypted secrets vault (`friday secrets` / ADR-038; auto-inits the vault on first run), sets the **serve-intent** (`tunnel.serve: true` in `config.json`), and invokes `cloudflared service install <TOKEN>`, which writes `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist` with `RunAtLoad: true` + `KeepAlive`. The tunnel comes back automatically after reboot — no separate `brew services start` step. (Brew's auto-generated `homebrew.mxcl.cloudflared.plist` runs `cloudflared` bare, which only supports config-file-based named tunnels — connector tokens have no config.yml equivalent, so we sidestep that plist entirely.)

**Reconcile, not fire-and-forget (FRI-166).** Since FRI-166, `friday start` reconciles the cloudflared agent to desired state on every launch — it keys on serve-intent (`tunnel.serve`) AND token presence, so a restored config relights the tunnel on the same box automatically (DR), removing the token tears it down, and a staged second machine stays dark until you flip intent. `friday tunnel up` / `friday tunnel down` are the explicit serve-intent lever (no token re-prompt). See `docs/running.md` → _Tunnel reconcile_.

### Create the tunnel in Cloudflare

1. Cloudflare Zero Trust dashboard → **Networks → Connectors → Create a tunnel**.
2. Pick the **Cloudflared** connector, name it `friday`, and copy the **connector token** shown on the install screen.
3. Under **Public Hostname**, add a route: `friday.<your-domain>.com` → `http://127.0.0.1:7615`. (This is the prod dashboard port — see `docs/running.md`.)

### Configure Friday

```bash
friday setup --cloudflare
```

Paste the token and your public URL (e.g. `https://friday.example.com`). The token is written to the vault as `CLOUDFLARE_TUNNEL_TOKEN` (`--daemon` scope); the public URL is stored in `~/.friday/config.json` for display; `tunnel.serve` is set on; the launch agent is installed and started immediately.

### Run

The tunnel runs under its own launchd job, reconciled by `friday start` against serve-intent + token (FRI-166):

```bash
friday status         # shows tunnel up / staged / down + public URL
friday tunnel status  # serve-intent, token, agent state, public URL
friday tunnel down    # stop serving from this box (clears serve-intent; keeps token)
friday tunnel up      # start serving again (re-flips serve-intent; no token re-prompt)
friday logs tunnel -f # tail cloudflared output
cloudflared service uninstall   # low-level: tear down the launch agent directly
```

`friday start` reconciles cloudflared to match `tunnel.serve` + token presence; `friday stop` leaves the tunnel's own launchd job alone (it self-supervises). Prefer `friday tunnel up`/`down` over poking `launchctl`/`cloudflared` directly so config and reality stay in sync.

If `cloudflared` is missing from `PATH` when you run `friday setup --cloudflare`, the token is still saved to the vault but the launch agent install is skipped with a one-line note; install `cloudflared` then re-run setup. `friday doctor` surfaces both conditions.

## Secrets vault (ADR-038)

Integration secrets (API keys, webhooks, app credentials) live in an age-encrypted vault safe to commit to your `~/.friday` git repo. Machine-local autogen secrets (`BETTER_AUTH_SECRET`, `ZERO_*`, `DATABASE_URL`) stay in gitignored `.env.local`.

```bash
friday stop
friday secrets init
friday secrets migrate-from-env   # moves integration keys from legacy .env → vault
friday secrets audit --git-history
friday start
friday doctor
```

Operator commands: `friday secrets set/get/list/unset/edit`, `friday secrets unlock --check`, `friday secrets public-key`. Agents fetch on-demand secrets via `mcp__friday-secrets__secrets_fetch` (audited). Env-mode secrets inject into MCP stdio `env` only when referenced as `${VAR}` in manifest/config.

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
- Configure the Linear integration team under `linear.team` (accepts a team
  key like `"FRI"` or a Linear team UUID). Used by `createIssue` when
  Friday files Linear issues. Overridable per-process with the
  `FRIDAY_LINEAR_TEAM` env var. When unset, the integration falls back to
  the first team the API key can see and logs a warning.
- Tune context compaction under `compaction` (`sweepHour`, `sweepMinute`,
  `sweepThresholdTokens`, `autoCompactWindow`). All four default in code
  (never `.env`); see `docs/running.md` → _Config-file knobs_ for the
  defaults and the two-number sweep/ceiling scheme.

Edit `~/.friday/SOUL.md` to customize Friday's voice and identity. Source upgrades never overwrite this file.

### Analytics (optional)

Friday ships first-class [PostHog](https://posthog.com) instrumentation, off by default. Add your PostHog project key via the secrets vault:

```bash
friday secrets set POSTHOG_API_KEY --mode env --daemon
# Optional — defaults to https://us.i.posthog.com. Set for EU cloud or self-hosted:
friday secrets set POSTHOG_HOST --mode env --daemon
```

On the next `friday start`:

- **Daemon** (`posthog-node`) emits business events (`agent_registered`, `chat_turn_dispatched`, `turn_completed`/`turn_errored`, `schedule_*`, `app_installed`) plus exception autocapture.
- **Dashboard** (`posthog-js`, the official SvelteKit integration) captures pageviews, autocapture, **session replay**, client + server error tracking, and product events (`message_sent`, `slash_command_invoked`, `agent_focused`), identifying the signed-in user.

With no key set, both clients construct with an empty key and silently no-op — nothing is sent. See the env-var table in `docs/running.md`. Session replay must also be enabled in your PostHog project settings (it is on by default for new projects).

The dashboard routes all PostHog traffic through a **first-party reverse proxy** at `/ingest` (`src/routes/ingest/[...path]/+server.ts`) rather than calling `us.i.posthog.com` directly. This is what keeps content/ad blockers — common on the mobile Safari clients that reach Friday over the Cloudflare Tunnel — from silently blocking ingestion and session replay. `posthog-js` is pointed at `api_host: '/ingest'`; the proxy forwards to `POSTHOG_HOST` (and its `-assets` host) server-side. No configuration needed; it follows `POSTHOG_HOST` automatically.

### Installing apps

Friday Apps (ADR-021, FRI-78) are folders that bundle agents, schedules, and stdio MCP servers. Install with one command:

```
friday app install ~/path/to/my-app
```

The folder must contain a `manifest.json`. Friday's apps live under `~/.friday/apps/<id>/`. See `docs/architecture.md` §Apps for the layout, and `services/daemon/src/apps/fixtures/example-app/` for a canonical minimal example.

## 8. Backup, restore, and the SQLite cutover

Friday's canonical state lives in two places:

1. The `friday` Postgres database (agents, blocks, tickets, mail, memory, schedules, apps, settings, read-cursors, client-devices).
2. `~/.friday/` (config, secrets, SOUL.md, skills, memory entries on disk, evolve proposals, app folders, uploads, schedules).

`friday backup` packs both into a single portable `.tar.gz`. `friday restore` is the inverse.

### Routine backup

```bash
# Default output: ~/.friday/backups/<timestamp>.tar.gz
friday backup

# Or pick a path:
friday backup /path/to/backup.tar.gz
```

Contents (per the bundle's `manifest.json`):

- `postgres.dump` — `pg_dump -Fc` of the `friday` database.
- `.env`, `SOUL.md`, `config.json` — top-level configuration.
- `skills/`, `memory/entries/`, `evolve/proposals/`, `apps/`, `schedules/`, `uploads/` — filesystem state.

Excludes by design: `workspaces/` (rebuildable git worktrees), `logs/`, `health.json`, `usage.jsonl`, `zero/` (zero-cache's replica, rebuilt from Postgres logical replication on next start), `state/` (tied to the running supervisor).

The bundle write is atomic — stages in a tempdir, single `tar -czf` to `<path>.tmp`, then renames to the final name.

### Full (migration) bundle

For a faithful machine-to-machine migration, use `friday backup --full --include-age-key`. It captures the **whole `~/.friday`** (including the `.git` state repo and `.env.local`) minus the regenerable/machine-tied bulk above, **plus** the Claude SDK session transcripts (`~/.claude/projects/<cwd>/<sessionId>.jsonl` + sidecars) for every non-archived agent. Without those transcripts the SDK silently starts a **fresh** session after restore — the Postgres history still renders, but each agent loses its Claude-side conversation context. `--include-age-key` adds `.age-key` so the secrets vault decrypts on the target (→ the bundle is **not** safe to distribute).

`friday restore` of a full bundle restores the whole tree, **re-derives** each Claude session path from the target machine's cwd (so resume finds them even if `$HOME`/user differs), and **syncs the local `friday` role's password** to the restored `.env.local` (so `pg_restore` + the daemon can authenticate even though the target minted a different password at `friday setup`).

### Restore

```bash
friday stop daemon
friday stop zero-cache
friday restore ~/path/to/backup.tar.gz [--force]
friday start daemon
```

`friday restore` refuses if the daemon or zero-cache is running (both hold connections to the friday database / replication slot). It refuses to overwrite a non-empty `friday` database unless `--force` is passed.

Sequence:

1. Validate the bundle (checksum of `postgres.dump` matches the manifest).
2. Drop any zero-cache logical replication slots — the daemon and zero-cache re-create them on next start.
3. `DROP DATABASE friday; CREATE DATABASE friday OWNER friday;`.
4. Restore filesystem.
5. **Force the Cloudflare tunnel dark (FRI-166).** A `--full` bundle restores the source machine's tunnel token (vault) and its `tunnel.serve: true` config. Restore overrides `tunnel.serve` to `false` and reconciles the cloudflared agent down, so `friday start` won't auto-serve — two connectors on one public hostname is split-brain. The token is kept; relight deliberately with `friday tunnel up` (after stopping the source machine's tunnel).
6. Run `pg_restore` against the `friday` role via `DATABASE_URL` so restored objects end up correctly owned.
7. Re-apply pending migrations.
8. Run `friday doctor` for a readiness check.

**Migration cutover (prod → new machine).** This is exactly why restore leaves the tunnel dark: stage the new box with `friday restore`, verify locally on `http://localhost:7615`, then cut over — stop the tunnel on the OLD box (`friday tunnel down`), then `friday tunnel up` on the NEW box. Same token → same tunnel hostname, new connector, no DNS change, never two live at once.

### One-time SQLite → Postgres cutover

Existing users coming from the pre-Postgres SQLite era migrate with two one-shot commands. The path is non-interactive and idempotent against partial runs:

```bash
# 1. Quiesce Friday.
friday stop

# 2. Preserve the old SQLite as a sidecar (the export reads this exact path
#    by default; pass --source if you stored it elsewhere).
mv ~/.friday/db.sqlite ~/.friday/db.sqlite.pre-postgres.bak

# 3. Export the SQLite contents to a portable JSON+filesystem bundle.
friday export-legacy-sqlite ~/legacy.bundle.tar.gz

# 4. Provision Postgres + the friday role + schema.
friday setup

# 5. Restore the legacy bundle into the empty Postgres database.
friday restore ~/legacy.bundle.tar.gz

# 6. Bring Friday back up + verify.
friday start
friday doctor
```

The export writes one NDJSON file per table under `rows/<table>.ndjson`, applies the column conversions Postgres needs (integer-ms timestamps → ISO strings; SQLite text JSON → object literals), filters out streaming-only blocks (in-flight bytes at the moment the daemon was stopped), and skips the retired `turns` table (ADR-016). The bundle's `manifest.json` carries per-table SHA-256 so the restore side verifies completeness before INSERTing.

`friday restore` auto-detects the bundle type from `manifest.bundleType` (`pg_dump` from `friday backup`, `legacy_sqlite` from `friday export-legacy-sqlite`) and dispatches accordingly.

If the export errors on a column you don't recognize, check the source SQLite schema (`sqlite3 ~/.friday/db.sqlite.pre-postgres.bak ".schema <table>"`) and the column maps in `packages/cli/src/commands/export-legacy-sqlite.ts` (`TIMESTAMP_COLUMNS`, `JSON_COLUMNS`). The cutover happens once per user, so a one-off schema patch is the expected friction point.

## 9. Troubleshooting

| Symptom                                                            | Try                                                                                          |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Login page won't accept credentials                                | `friday setup --reset-password`                                                              |
| Daemon won't start                                                 | `friday doctor`; check `~/.friday/logs/daemon.jsonl`                                         |
| Dashboard shows "daemon not reachable"                             | Confirm daemon is running: `friday status`                                                   |
| Tunnel won't connect                                               | `friday doctor` then `friday logs tunnel -f`                                                 |
| SSE drops on phone                                                 | Check Cloudflare Tunnel timeout; the daemon sends keepalives every 20s                       |
| `friday restore` fails with "slot active for PID …"                | A backend still holds the replication slot. `friday stop zero-cache` then retry.             |
| `friday restore` fails with "permission denied for schema drizzle" | Rare ownership mismatch after pg_restore. Drop the database manually, `friday setup`, retry. |
