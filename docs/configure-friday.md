# Configure Friday

All runtime configuration and state lives in `~/.friday/`. This guide covers initial setup and available options.

## Directory Setup

```bash
mkdir -p ~/.friday/sessions
```

## Tokens

Create `~/.friday/.env` with your Slack tokens (see [setup-friday.md](setup-friday.md) for how to obtain these):

```bash
SLACK_APP_TOKEN=xapp-your-token-here
SLACK_BOT_TOKEN=xoxb-your-token-here
```

## Config File

Create `~/.friday/config.json`:

```json
{
  "slack": {
    "orchestratorChannelId": "C0123ABCDEF"
  },
  "agent": {
    "workingDirectory": "/path/to/your/project"
  }
}
```

To find the channel ID: right-click the channel in Slack, select **View channel details**, and copy the ID at the bottom of the modal.

Only fields you want to override need to be specified -- everything else uses sensible defaults. The config is deep-merged, so setting `agent.model` won't blow away `agent.allowedTools`.

### Validate

```bash
./bin/friday config --validate
```

This checks for required fields and warns about issues like a missing `workingDirectory`.

## Config Reference

### `slack`

| Field | Default | Description |
|-------|---------|-------------|
| `orchestratorChannelId` | `""` (required) | Slack channel ID for the orchestrator session |

### `agent`

| Field | Default | Description |
|-------|---------|-------------|
| `workingDirectory` | `"."` | Working directory for Claude Code sessions |
| `model` | `"claude-sonnet-4-6"` | Model to use for agent sessions |
| `allowedTools` | `["Read", "Write", ...]` | Tools the agent can use |
| `permissionMode` | `"auto-accept"` | Permission mode for tool calls |
| `systemPrompt` | (none) | Custom system prompt appended to the Claude Code default |

### `independentAgent`

Optional config for non-orchestrator channel sessions. Same fields as `agent`. Defaults to read-only tools (`Read`, `Glob`, `Grep`) and `auto-accept` permission mode. Set to override behavior for DMs or other channels.

### `slack_formatting`

| Field | Default | Description |
|-------|---------|-------------|
| `maxMessageLength` | `4000` | Max characters per Slack message before chunking |
| `streamingEnabled` | `true` | Stream responses as the agent types |
| `emojiReactions.processing` | `"eyes"` | Emoji shown while processing |
| `emojiReactions.queued` | `"clock1"` | Emoji shown for queued messages |
| `emojiReactions.error` | `"x"` | Emoji shown on error |

### `monitoring`

| Field | Default | Description |
|-------|---------|-------------|
| `warnAtPercentOfDailyLimit` | `80` | Usage warning threshold (percentage) |

## File Layout

```
~/.friday/
├── config.json          -- Runtime config (channel IDs, agent settings, formatting)
├── .env                 -- Secrets (SLACK_APP_TOKEN, SLACK_BOT_TOKEN)
├── health.json          -- Daemon heartbeat (present = running)
├── pids/                -- PID files for managed services
├── sessions/
│   └── channels.json    -- Channel ID → Agent SDK session ID mapping
└── usage.jsonl          -- Per-turn usage log (cost, tokens, cache hits, duration)
```
