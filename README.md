```
                                                                   
     ▄▄                              ▄▄▄▄▄▄▄                       
   ▄█▀▀█▄                     █▄    █▀██▀▀▀          █▄            
   ██  ██      ▄▄       ▄    ▄██▄     ██  ▄    ▀▀    ██            
   ██▀▀██   ▄████ ▄█▀█▄ ████▄ ██      ███▀████▄██ ▄████ ▄▀▀█▄ ██ ██
 ▄ ██  ██   ██ ██ ██▄█▀ ██ ██ ██    ▄ ██  ██   ██ ██ ██ ▄█▀██ ██▄██
 ▀██▀  ▀█▄█▄▀████▄▀█▄▄▄▄██ ▀█▄██    ▀██▀ ▄█▀  ▄██▄█▀███▄▀█▄██▄▄▀██▀
               ██                                               ██ 
             ▀▀▀                                              ▀▀▀  

```

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

- **Persistent sessions** -- each Slack channel maps to a Claude Code session with full conversation history
- **Message queuing** -- send messages while the agent is busy; they queue up and batch automatically
- **Streaming responses** -- see the agent's output as it types, not after it finishes
- **Slash commands** -- `/friday reset`, `/friday session`, `/friday help`
- **Usage tracking** -- per-turn cost, token, and cache hit rate logging
- **Management CLI** -- `friday start`, `friday stop`, `friday status`, `friday usage`
- **Dashboard** -- optional SvelteKit web UI for monitoring

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
friday dev start [service]      # Dev mode with hot reload
```

## Project Structure

```
agent-friday/
├── packages/
│   ├── shared/          # Shared types and config (FridayConfig, UsageEntry)
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
# Full suite (110 tests across 3 packages)
pnpm test

# Single package
pnpm --filter @friday/cli run test
pnpm --filter @friday/daemon run test
pnpm --filter @friday/shared run test
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
