import { execFileSync, spawnSync } from "node:child_process";

/** Per-service tmux helpers. Each service gets its own session. */

export function tmuxAvailable(): boolean {
  return spawnSync("which", ["tmux"], { encoding: "utf8" }).status === 0;
}

export function hasSession(name: string): boolean {
  return (
    spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" })
      .status === 0
  );
}

export function newSession(name: string, command: string, cwd: string): void {
  execFileSync(
    "tmux",
    ["new-session", "-d", "-s", name, "-c", cwd, "bash", "-lc", command],
    { stdio: "inherit" },
  );
}

export function killSession(name: string): void {
  spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
}

export function attachSession(name: string): void {
  spawnSync("tmux", ["attach-session", "-t", name], { stdio: "inherit" });
}

export function listSessions(): string[] {
  const r = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter(Boolean);
}

export function paneCommand(name: string): string {
  const r = spawnSync(
    "tmux",
    ["list-panes", "-t", name, "-F", "#{pane_current_command}"],
    { encoding: "utf8" },
  );
  return r.stdout.trim();
}
