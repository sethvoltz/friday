# Setup Friday

This guide covers prerequisites, creating the Slack app, and obtaining tokens. For configuration, see [configure-friday.md](configure-friday.md).

## Prerequisites

### Claude Code CLI

Friday runs Claude Code sessions via the Agent SDK. You need the CLI installed and authenticated:

```bash
npm install -g @anthropic-ai/claude-code
claude --version   # Verify installation
```

You must be logged in with an active Pro or Max subscription. No `ANTHROPIC_API_KEY` is needed — billing goes through your subscription (see ADR-003 in [decisions.md](decisions.md)).

### GitHub CLI (`gh`)

Builders use `gh` for cloning repos and opening PRs:

```bash
brew install gh     # macOS
gh auth login       # Authenticate with GitHub
gh auth status      # Verify
```

### Beads (`bd`)

The inter-agent task and mail system uses Beads as its backing store:

```bash
# Install beads (see beads repo for latest instructions)
npm install -g @beads/bd

# Initialize the Friday beads database
mkdir -p ~/.friday/beads
cd ~/.friday/beads && bd init --non-interactive --prefix friday --skip-agents --skip-hooks
```

The beads database lives at `~/.friday/beads/`. All agents reference this path via the `BEADS_DIR` constant.

### Node.js & pnpm

```bash
node --version   # v20+ required
pnpm --version   # v9+ required
```

## 1. Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From a manifest** and select your workspace
3. Paste this manifest (YAML tab):

```yaml
display_information:
  name: Friday
  description: Local AI orchestrator bridge

features:
  bot_user:
    display_name: friday
    always_online: true
  slash_commands:
    - command: /friday
      description: Send a command to Friday
      usage_hint: "[reset]"
      should_escape: false

oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - channels:history
      - im:history
      - groups:history
      - commands
      - files:read
      - files:write
      - reactions:read
      - reactions:write
      - users:read

settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - app_mention
  socket_mode_enabled: true
```

4. Click **Create**

## 2. Get Tokens

### App Token (Socket Mode)
1. Go to **Settings → Basic Information → App-Level Tokens**
2. Click **Generate Token and Scopes**
3. Name it `socket-mode`, add scope `connections:write`
4. Copy the token (`xapp-...`)

### Bot Token
1. Go to **Features → OAuth & Permissions**
2. Click **Install to Workspace** and authorize
3. Copy the **Bot User OAuth Token** (`xoxb-...`)

## 3. Invite the Bot

In Slack, go to your orchestrator channel and type:
```
/invite @Friday
```

## Next Steps

- [Configure Friday](configure-friday.md) — set up tokens, config, and channel mapping
- [Running Friday](running.md) — start the daemon in dev or production mode
