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
  dev                Development mode commands
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

Usage: friday start [service]

Services:
  daemon             The Friday bridge daemon
  dashboard          The management dashboard

If no service is specified, starts all services.

Options:
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

Usage: friday status

Checks PID files and health.json to report the state of
Friday services.

Options:
  --help, -h         Show this help
`.trim();

const DEV_HELP = `
friday dev — Development mode commands

Usage: friday dev <command> [service]

Commands:
  start [service]         Start services in dev mode (tsx watch, hot reload)
  restart <service>       Restart a specific service in dev mode
  reset-orchestrator      Clear orchestrator session (daemon must be stopped)

Services:
  daemon             The Friday bridge daemon
  dashboard          The management dashboard

If no service is specified for 'start', starts all services.

Options:
  --help, -h         Show this help
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

export const HELP: Record<string, string> = {
  main: MAIN_HELP,
  usage: USAGE_HELP,
  config: CONFIG_HELP,
  start: START_HELP,
  stop: STOP_HELP,
  restart: RESTART_HELP,
  status: STATUS_HELP,
  mail: MAIL_HELP,
  dev: DEV_HELP,
  inspect: INSPECT_HELP,
  transcript: TRANSCRIPT_HELP,
};

export function showHelp(command: string): void {
  console.log(HELP[command] ?? HELP.main);
}

export function hasHelpFlag(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}
