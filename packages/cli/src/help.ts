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
  start [service]    Start services in dev mode (tsx watch, hot reload)
  restart <service>  Restart a specific service in dev mode

Services:
  daemon             The Friday bridge daemon
  dashboard          The management dashboard

If no service is specified for 'start', starts all services.

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
  dev: DEV_HELP,
};

export function showHelp(command: string): void {
  console.log(HELP[command] ?? HELP.main);
}

export function hasHelpFlag(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}
