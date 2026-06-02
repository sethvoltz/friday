/**
 * citty renders `--version` through consola, whose non-TTY "basic" reporter
 * prefixes log lines with `[log] ` — so `friday --version` under CI or in a
 * pipe emits `[log] 0.0.1` instead of a parseable bare version (a real user
 * scripting `friday --version` gets the polluted form; only an interactive
 * TTY printed it cleanly). Short-circuit the top-level version flag and write
 * the bare version to stdout before citty/consola ever sees it.
 *
 * Only fires when the version flag is the SOLE top-level argument
 * (`friday --version` / `friday -v`), so subcommand flags are left to citty.
 */
export function maybePrintVersion(
  argv: string[],
  version: string,
  write: (s: string) => void = (s) => process.stdout.write(s),
): boolean {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    write(`${version}\n`);
    return true;
  }
  return false;
}
