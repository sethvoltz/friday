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
# Start everything in dev mode (daemon + dashboard with hot reload)
./bin/friday dev start

# Or start just the daemon
./bin/friday dev start daemon
```

Send a message in your orchestrator channel. Friday will pick it up.

> **Tip:** Add `./bin` to your PATH to use `friday` directly, or invoke the shim as `./bin/friday` from the repo root.

## CLI

The `friday` CLI manages services and reports usage without needing the daemon running.

```bash
# During development, use the shim:
./bin/friday <command>

# Commands:
friday status                   # Check what's running
friday start [daemon|dashboard] # Start services (detached)
friday stop [daemon|dashboard]  # Stop services
friday restart <service>        # Restart a service
friday usage                    # Cost/token report
friday usage -v                 # Verbose token breakdown
friday config                   # Print resolved config
friday config --validate        # Validate config
friday inspect <agent>          # Show last N turns from an agent's transcript (--follow tails)
friday transcript <agent>       # Export full session transcript as markdown
friday schedule                 # Manage scheduled agents (list, create, pause, trigger, ...)
friday dev start [service]      # Dev mode with hot reload
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
├── bin/friday            # Dev shim
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
# Start everything with hot reload
./bin/friday dev start

# Or start a specific service
./bin/friday dev start daemon
./bin/friday dev start dashboard
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
