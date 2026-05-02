# Setup Friday

This guide covers prerequisites, creating the Slack app, and obtaining tokens. For configuration, see [configure-friday.md](configure-friday.md).

## Prerequisites

### CLI tools

Friday depends on three external CLIs: **Claude Code** (runs Agent SDK sessions), **`gh`** (Builders use it for clone + PRs), and **`bd`** ([Beads](https://github.com/steveyegge/beads), the backing store for inter-agent mail/tasks). Install them all from the included [`Brewfile`](../Brewfile):

```bash
brew bundle --file=Brewfile

claude --version    # Verify Claude Code
gh --version        # Verify gh
bd --version        # Verify Beads
```

Then authenticate Claude Code (Pro or Max subscription — no `ANTHROPIC_API_KEY` needed; billing goes through your subscription, see ADR-003 in [decisions.md](decisions.md)) and GitHub:

```bash
gh auth login
gh auth status
```

The Friday beads database lives at `~/.friday/beads/` and is initialized automatically by `friday setup` (below). All agents reference this path via the `BEADS_DIR` constant.

### Node.js & pnpm

```bash
node --version   # v22+ required
pnpm --version   # v10+ required
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

## 4. Run `friday setup`

From the repo root, run the interactive setup. It creates `~/.friday/`, prompts for the tokens you just created, asks for the orchestrator channel ID, and initializes the beads database:

```bash
./bin/friday setup
```

Pass `--yes` to skip prompts and accept current/default values. Setup ends by running `friday doctor` so you can confirm everything is wired up.

## 5. Shell Completion (Optional)

Friday ships static completion scripts for zsh and bash. They list subcommands from a hand-maintained manifest, so tab completion never triggers heavy lazy imports.

### zsh

```bash
mkdir -p ~/.zsh/completions
friday completion zsh > ~/.zsh/completions/_friday
echo 'fpath=(~/.zsh/completions $fpath)' >> ~/.zshrc
echo 'autoload -Uz compinit && compinit' >> ~/.zshrc
```

### bash

```bash
friday completion bash > ~/.local/share/bash-completion/completions/friday
# or, source it directly from your bashrc:
echo 'source <(friday completion bash)' >> ~/.bashrc
```

Restart your shell, then `friday <Tab>` lists subcommands and `friday evolve <Tab>` lists evolve subcommands.

## Next Steps

- [Configure Friday](configure-friday.md) — config file reference and tunable options
- [Running Friday](running.md) — start the daemon in dev or production mode
