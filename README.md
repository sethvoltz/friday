<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/readme-header-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="images/readme-header-light.png">
  <img alt="Friday — Understands context. Executes tasks. Builds solutions." src="images/readme-header-light.png">
</picture>

Your local Slack-to-Claude-Code bridge. Command an AI agent from anywhere -- just send a Slack message.

---

## What is Friday?

Friday is a local-first daemon that connects Slack to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions running on your machine. You message a Slack channel, Friday routes it to Claude's Agent SDK, and the response streams back -- with full access to your local filesystem, tools, and dev environment.

No servers to deploy. No API keys to manage. Runs on your existing Claude Pro/Max subscription.

**How it works:**

```
Slack (Socket Mode) --> Friday Daemon --> Claude Agent SDK --> Claude Code --> Your Machine
```

**Key features:**

- **Multi-agent orchestration** -- the orchestrator spins up isolated **Builder** agents for project work in their own git worktrees, and short-lived **Helpers** for delegated tasks. Builders are workspace-confined by a tool-call guard. Agents communicate via an inter-agent **mail** system.
- **Scheduled agents** -- autonomous cron and one-shot agents run unattended, persist a `state.md` between runs (auto-injected into the next prompt), and escalate to the orchestrator via mail if anything goes sideways. Catch up missed runs on restart, cooperatively abort on shutdown.
- **Self-improvement loop** -- the `friday-evolve` pipeline scans daemon logs, usage, transcripts, and feedback for friction signals (Haiku grades orchestrator turns for correction, frustration, and redirect), then Sonnet rewrites the top-ranked proposals with root-cause analysis. Daily and weekly meta-agents run it unattended and surface a prioritized backlog of system improvements in the dashboard.
- **Proactive memory** -- file-based markdown memories with hybrid keyword search and recall-frequency boosting. The daemon **auto-recalls relevant memories** and prepends them to the orchestrator's prompt — no `memory_search` call required.
- **Multimodal** -- image attachments in Slack are fetched with the bot token, base64-encoded, and forwarded to Claude as vision content alongside the text.
- **Live dashboard** -- SvelteKit UI streams real-time updates over SSE. Browse session transcripts (with markdown rendering), monitor schedules and their state files, explore the memory store, and watch agents tick through turns as they happen.
- **Persistent sessions** -- each Slack channel maps to a Claude Code session resumed across daemon restarts. Full prompt-cache benefits (~58% cost reduction on resumed turns).
- **Resilient message handling** -- per-channel FIFO queue with edit/delete support, status-emoji reactions (thinking, tools, compacting), streaming responses throttled at 1/sec, and boot-time Slack cleanup that patches dangling state from crashes.

## Quick Start

### Prerequisites

- **Node.js** >= 22
- **pnpm** >= 10
- **Claude Code** installed and authenticated (`claude` CLI on PATH)
- A **Slack workspace** you can create apps in

### 1. Clone and install

```bash
git clone <repo-url> agent-friday
cd agent-friday
pnpm install
```

### 2. Create a Slack app and get tokens

Follow the [Setup guide](docs/setup-friday.md) to create a Socket Mode Slack app and obtain your App Token (`xapp-...`) and Bot Token (`xoxb-...`).

### 3. Configure Friday

Follow the [Configuration guide](docs/configure-friday.md) to set up `~/.friday/` with your tokens, config file, and channel mapping. The short version:

```bash
mkdir -p ~/.friday/sessions
```

Add tokens to `~/.friday/.env`, set your orchestrator channel in `~/.friday/config.json`, and `/invite @Friday` in the channel.

### 4. Run

```bash
# Start everything in dev mode (daemon + dashboard, each in its own tmux session)
./bin/friday start all --dev

# Or start just the daemon
./bin/friday start daemon --dev

# Attach to the live tmux pane (Ctrl-b d to detach)
./bin/friday attach daemon
```

Send a message in your orchestrator channel. Friday will pick it up.

> **Tip:** Add `./bin` to your PATH to use `friday` and `friday-evolve` directly, or invoke the shims as `./bin/friday` / `./bin/friday-evolve` from the repo root.

## CLI

The `friday` CLI manages services and reports usage without needing the daemon running.

```bash
# During development, use the shim:
./bin/friday <command>

# Commands:
friday status [service] [--json]  # Check what's running (--json: agent contract)
friday start [service] [--dev]    # Start in prod (default) or dev (tmux + hot reload)
friday stop [service]             # Stop a service or all
friday restart <service>          # Mode-preserving restart
friday attach <service>           # Attach to a dev-mode tmux session
friday logs <service> [-f] [--pretty] [-n N]  # Tail ~/.friday/logs/<svc>.jsonl
friday reset-orchestrator         # Wipe orchestrator session (daemon must be stopped)
friday usage                      # Cost/token report
friday usage -v                   # Verbose token breakdown
friday config                     # Print resolved config
friday config --validate          # Validate config
friday inspect <agent>            # Show last N turns from an agent's transcript (--follow tails)
friday transcript <agent>         # Export full session transcript as markdown
friday schedule                   # Manage scheduled agents (list, create, pause, trigger, ...)
```

## Project Structure

```
agent-friday/
├── packages/
│   ├── shared/          # Shared types and config (FridayConfig, UsageEntry, agents)
│   ├── memory/          # File-based memory store with hybrid search
│   └── cli/             # CLI entrypoint (@friday/cli)
├── services/
│   ├── friday/          # Bridge daemon (@friday/daemon)
│   └── dashboard/       # SvelteKit management UI
├── bin/                  # Dev shims (friday, friday-evolve) — runs source via tsx
└── docs/                # Documentation index, setup, config, architecture
```

## Developing

**Stack:** TypeScript, pnpm workspaces, Turborepo, Vitest, SvelteKit

### Setup

```bash
pnpm install
pnpm build        # Build all packages
```

### Dev mode

```bash
# Start everything with hot reload (each service in its own tmux session)
./bin/friday start all --dev

# Or start a specific service
./bin/friday start daemon --dev
./bin/friday start dashboard --dev

# Attach to a live session, or follow logs without attaching
./bin/friday attach dashboard
./bin/friday logs dashboard -f --pretty
```

### Testing

```bash
# Full suite (~400 tests across 4 packages)
pnpm test

# Single package
pnpm --filter @friday/cli run test
pnpm --filter @friday/daemon run test
pnpm --filter @friday/shared run test
pnpm --filter @friday/memory run test
```

Tests are co-located with source as `*.test.ts` and run via Vitest. All tests are deterministic -- no network calls, no real Slack or Claude connections. See [docs/architecture.md](docs/architecture.md#testing) for conventions.

### Build

```bash
pnpm build        # Turborepo builds shared first, then services in parallel
```

### Validate config

```bash
./bin/friday config --validate
```

## Documentation

See [docs/index.md](docs/index.md) for the full documentation index, including setup, configuration, architecture, and decision records.

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.
