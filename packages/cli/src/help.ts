const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;

export const BANNER = cyan(`
     ▄▄                              ▄▄▄▄▄▄▄
   ▄█▀▀█▄                     █▄    █▀██▀▀▀          █▄
   ██  ██      ▄▄       ▄    ▄██▄     ██  ▄    ▀▀    ██
   ██▀▀██   ▄████ ▄█▀█▄ ████▄ ██      ███▀████▄██ ▄████ ▄▀▀█▄ ██ ██
 ▄ ██  ██   ██ ██ ██▄█▀ ██ ██ ██    ▄ ██  ██   ██ ██ ██ ▄█▀██ ██▄██
 ▀██▀  ▀█▄█▄▀████▄▀█▄▄▄▄██ ▀█▄██    ▀██▀ ▄█▀  ▄██▄█▀███▄▀█▄██▄▄▀██▀
               ██                                               ██
             ▀▀▀                                              ▀▀▀
`);

const MAIN_HELP = `
friday — CLI for the Friday Slack-to-Claude bridge

Usage: friday <command> [options]

Commands:
  usage              Show usage stats (cost, tokens, cache hit rate)
  config             Print current configuration
  start [service]    Start services (daemon, dashboard, or all)
  stop [service]     Stop services (daemon, dashboard, or all)
  restart <service>  Restart a specific service (daemon or dashboard)
  status             Show running services and health
  inspect <agent>    Inspect an agent's recent transcript
  transcript <agent> Export full transcript as markdown
  mail               Inter-agent mail (check, read, send)
  send               Shorthand for 'friday mail send'
  schedule           Manage scheduled (cron) agents
  attach <service>   Attach to a dev-mode service's tmux session
  logs <service>     Tail a service's structured JSONL log
  reset-orchestrator Clear orchestrator session (daemon must be stopped)
  doctor             Validate your Friday installation
  setup              Bootstrap a new Friday installation
  help               Show this help message

Options:
  --help, -h         Show help for a command

Run 'friday <command> --help' for details on a specific command.
`.trim();

const USAGE_HELP = `
friday usage — Show usage stats

Usage: friday usage [options]

Reads ~/.friday/usage.jsonl and reports cost, token, and cache stats.
Does not make any LLM calls.

Options:
  -v, --verbose      Show token breakdown
  --help, -h         Show this help
`.trim();

const CONFIG_HELP = `
friday config — Print current configuration

Usage: friday config [options]

Reads and displays ~/.friday/config.json merged with defaults.

Options:
  --validate         Validate config and report issues
  --path             Print config file path only
  --help, -h         Show this help
`.trim();

const START_HELP = `
friday start — Start services

Usage: friday start [service] [--dev]

Services:
  daemon             The Friday bridge daemon
  dashboard          The management dashboard

If no service is specified, starts all services.

Modes:
  default (prod)     Runs the built artifact (node dist/index.js).
                     Errors if the artifact is missing or stale —
                     run \`pnpm --filter <pkg> build\` first.
  --dev              Runs the dev script (hot reload) inside a tmux
                     session named friday-<svc>. Attach via:
                     friday attach <svc>

Options:
  --dev              Start in dev mode (tmux + hot reload)
  --help, -h         Show this help
`.trim();

const STOP_HELP = `
friday stop — Stop services

Usage: friday stop [service]

Services:
  daemon             The Friday bridge daemon
  dashboard          The management dashboard

If no service is specified, stops all services.

Options:
  --help, -h         Show this help
`.trim();

const RESTART_HELP = `
friday restart — Restart a service

Usage: friday restart <service>

Services:
  daemon             The Friday bridge daemon
  dashboard          The management dashboard

A service name is required — no ambiguous "restart everything".

Options:
  --help, -h         Show this help
`.trim();

const STATUS_HELP = `
friday status — Show running services and health

Usage: friday status [service] [--json]

States:
  running     Service is up (and pane alive in dev mode)
  crashed     dev: tmux session exists but pane is dead
  stale       state file present but process is gone
  stopped     no state file (service not started)

Options:
  --json             Emit machine-readable JSON (the contract for agents)
  --help, -h         Show this help

JSON shape:
  {
    "service": "dashboard",
    "state": "running",
    "mode": "dev",
    "pid": 12345,
    "tmuxSession": "friday-dashboard",
    "startedAt": "ISO 8601",
    "startCommand": ["friday", "start", "dashboard", "--dev"],
    "logPath": "/Users/.../.friday/logs/dashboard.jsonl",
    "lastLogTs": "ISO 8601 of last log line, or null"
  }
`.trim();

const MAIL_HELP = `
friday mail — Inter-agent mail system

Usage: friday mail [subcommand] [options]

Subcommands:
  (none)             List pending mail for the orchestrator
  list [agent]       List pending mail for an agent (default: orchestrator)
  read <id>          Read a specific message
  send               Send a message to an agent

Send options:
  --to <agent>       Recipient agent name (required)
  --subject, -s      Subject line (required)
  --body, -b         Message body (required)
  --urgent           Mark as urgent priority

Examples:
  friday mail                           Check orchestrator inbox
  friday mail list builder-blog         Check builder-blog inbox
  friday mail read friday-a3f2dd        Read a specific message
  friday mail send --to orchestrator --subject "Test" --body "Hello"

Options:
  --help, -h         Show this help
`.trim();

const INSPECT_HELP = `
friday inspect — Inspect an agent's recent transcript

Usage: friday inspect <agent-name> [options]

Shows the last N turns from an agent's Claude Code session transcript.

Options:
  --turns N          Number of recent turns to show (default: 5)
  --full             Show the entire transcript
  --follow, -f       Tail the transcript live (like tail -f)
  --no-tools         Hide tool call details
  --help, -h         Show this help

Examples:
  friday inspect orchestrator              Last 5 turns
  friday inspect builder-blog --turns 10   Last 10 turns
  friday inspect builder-blog --full       Full transcript
  friday inspect builder-blog -f           Watch live
`.trim();

const TRANSCRIPT_HELP = `
friday transcript — Export full transcript as markdown

Usage: friday transcript <agent-name> [options]

Exports the complete session transcript as a readable markdown document.

Options:
  --output, -o <file>  Write to file instead of stdout
  --help, -h           Show this help

Examples:
  friday transcript orchestrator
  friday transcript builder-blog -o builder-blog.md
`.trim();

const DOCTOR_HELP = `
friday doctor — Validate your Friday installation

Usage: friday doctor

Checks prerequisites, configuration, and services. Reports pass/warn/fail
for each item and exits with code 1 if any check fails.

Checks:
  ~/.friday/ directory, config.json, .env tokens, working directory,
  beads database, CLI tools (bd, claude, gh), Node.js, pnpm, services

Options:
  --help, -h         Show this help
`.trim();

const SETUP_HELP = `
friday setup — Bootstrap a new Friday installation

Usage: friday setup [options]

Creates the ~/.friday/ directory structure, prompts for Slack tokens and
orchestrator channel ID, writes config.json and .env, initializes the
beads database, and runs 'friday doctor' to validate.

Safe to re-run — existing values are used as defaults and config
customizations are preserved.

Options:
  --yes, -y          Accept defaults without prompting (for scripted installs)
  --help, -h         Show this help
`.trim();

const SCHEDULE_HELP = `
friday schedule — Manage scheduled (cron) agents

Usage: friday schedule <subcommand> [options]

Subcommands:
  list               List all scheduled agents (default)
  create             Create a new scheduled agent
  pause <name>       Pause a scheduled agent
  resume <name>      Resume a paused scheduled agent
  trigger <name>     Queue an immediate run
  delete <name>      Soft-delete a scheduled agent

Create options:
  --name <name>      Agent name (required, will be prefixed with 'scheduled-')
  --cron <expr>      5-field cron expression (e.g. '0 */6 * * *')
  --run-at <iso>     ISO 8601 timestamp for one-shot execution
  --tz <timezone>    Timezone for cron (e.g. 'America/New_York')
  --task <prompt>    Task prompt — what the agent does each run (required)
  --cwd <path>       Working directory (default: ~/.friday/working)
  --system-prompt    Additional system prompt context

Examples:
  friday schedule list
  friday schedule create --name openclaw --cron "0 */6 * * *" --task "Check OpenClaw API..."
  friday schedule pause scheduled-openclaw
  friday schedule trigger scheduled-openclaw
  friday schedule delete scheduled-openclaw

Options:
  --help, -h         Show this help
`.trim();

const LOGS_HELP = `
friday logs — Tail a service's structured JSONL log

Usage: friday logs <service> [-f] [--pretty] [-n N]

Reads from ~/.friday/logs/<service>.jsonl. Works regardless of mode —
in dev mode the same JSONL events that show up in the tmux pane are
also persisted here.

Options:
  -f, --follow       Tail and follow new lines (like tail -f)
  -n, --lines N      Print the last N lines (default: 50)
  --pretty           Colorize and pretty-print (default: raw JSON)
  --json             Force JSON output (raw)
  --help, -h         Show this help
`.trim();

const RESET_ORCH_HELP = `
friday reset-orchestrator — Clear the orchestrator's session

Usage: friday reset-orchestrator

Wipes the orchestrator session ID from agents.json and the channel
mapping from sessions/channels.json. The daemon must be stopped first
(this command refuses to run while it's alive).

Use this when an orchestrator session is wedged and a clean restart
is needed. The next \`friday start daemon\` will create a fresh session.

Options:
  --help, -h         Show this help
`.trim();

const ATTACH_HELP = `
friday attach — Attach to a dev-mode service's tmux session

Usage: friday attach <service>

Lands you in the service's interactive tmux session (vite/tsx watcher
output, HMR overlays, etc.). Detach with the standard tmux prefix +
d (default: Ctrl-b d).

Errors if the service is not running or is in prod mode.
For prod mode, use \`friday logs <service> -f\` instead.

Services:
  daemon             The Friday bridge daemon
  dashboard          The management dashboard

Options:
  --help, -h         Show this help
`.trim();

export const HELP: Record<string, string> = {
  main: MAIN_HELP,
  usage: USAGE_HELP,
  config: CONFIG_HELP,
  start: START_HELP,
  stop: STOP_HELP,
  restart: RESTART_HELP,
  status: STATUS_HELP,
  mail: MAIL_HELP,
  attach: ATTACH_HELP,
  logs: LOGS_HELP,
  "reset-orchestrator": RESET_ORCH_HELP,
  inspect: INSPECT_HELP,
  transcript: TRANSCRIPT_HELP,
  doctor: DOCTOR_HELP,
  setup: SETUP_HELP,
  schedule: SCHEDULE_HELP,
};

export function showHelp(command: string): void {
  console.log(HELP[command] ?? HELP.main);
}

export function hasHelpFlag(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}
