# Friday Setup

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

## 3. Configure Friday

```bash
mkdir -p ~/.friday/sessions
```

Create `~/.friday/.env`:
```bash
SLACK_APP_TOKEN=xapp-your-token-here
SLACK_BOT_TOKEN=xoxb-your-token-here
```

Create `~/.friday/config.json`:
```json
{
  "slack": {
    "orchestratorChannelId": "YOUR_CHANNEL_ID"
  },
  "agent": {
    "workingDirectory": "/Users/seth/Development/Seth",
    "model": "claude-sonnet-4-6"
  }
}
```

To find the channel ID: right-click the channel in Slack → **View channel details** → the ID is at the bottom of the modal.

## 4. Invite the Bot

In Slack, go to your orchestrator channel and type:
```
/invite @Friday
```

## 5. Run

```bash
cd agent-friday

# Install dependencies
pnpm install

# Run just the daemon
pnpm --filter @friday/daemon dev

# Or run everything (daemon + dashboard)
pnpm dev
```

The daemon will connect to Slack via Socket Mode and start listening for messages in the orchestrator channel.

The dashboard (optional) will be available at `http://localhost:5173`.
