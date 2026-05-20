/**
 * friday-supervisor — the launchd-supervised entrypoint for Friday's
 * production stack.
 *
 * Spawns daemon + dashboard + zero-cache as children with shared process
 * group. Watches each for exit; restarts with exponential backoff
 * (capped). Treats `zero-cache` exit code 14 (`AutoResetSignal`) as a
 * fast restart. Crash-loop guard: 5 failed restarts inside 60s causes
 * the supervisor itself to exit non-zero so launchd surfaces it.
 *
 * On SIGTERM / SIGINT: sends SIGTERM to its own process group, waits up
 * to 10s for descendants to exit, then escalates to SIGKILL. The
 * supervisor's process group includes every child and every grandchild
 * — closing the FRI-83 zombie gap from `tmux kill-session`, which only
 * signals the pane shell.
 *
 * The plist entry runs this binary as `bin/friday-supervisor`. launchd's
 * job-level process-group cleanup is the safety net under any
 * supervisor failure path; the supervisor's own cascade-stop is the
 * happy path.
 *
 * Design constraints (FRI-88 §0):
 *  - No tmux. No bash respawn wrappers. `friday stop` (now
 *    `brew services stop friday`) leaves zero descendants alive.
 */

import {
  ChildProcess,
  spawn,
  spawnSync,
  type StdioOptions,
} from "node:child_process";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureFridayEnv,
  getLogPath,
  LOGS_DIR,
  loadConfig,
  resolveDaemonPort,
  resolveDashboardPort,
} from "@friday/shared";

// ---- Layout -----------------------------------------------------------

/**
 * Repo root, derived from this script's location. The supervisor is
 * compiled to `<repo>/packages/cli/dist/bin/supervisor.js`; walk five
 * dirnames up to land on the repo root. Works identically in the dev
 * checkout and in the brew install (where the whole repo lives under
 * `libexec/`).
 */
function findRepoRoot(): string {
  let cur = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(cur, "pnpm-workspace.yaml"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error("supervisor: cannot locate repo root (no pnpm-workspace.yaml)");
}

// ---- .env loading -----------------------------------------------------

/**
 * Parse `~/.friday/.env` and inject every assignment into `process.env`
 * before spawning children. zero-cache reads `ZERO_UPSTREAM_DB`,
 * `ZERO_AUTH_SECRET`, etc. from env at spawn time; the daemon and
 * dashboard also read `DATABASE_URL`, `BETTER_AUTH_SECRET`,
 * `LINEAR_API_KEY`, etc. This replaces the `set -a && source ~/.friday/.env`
 * pattern from the tmux-era wrapper.
 *
 * Format is the dotenv-style `KEY=value` per line, ignoring blanks and
 * `#`-prefixed comments. Values are taken verbatim (no shell expansion).
 */
function loadFridayEnv(): void {
  ensureFridayEnv();
  const envPath = join(process.env.FRIDAY_DATA_DIR ?? join(process.env.HOME!, ".friday"), ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    // Don't clobber values that are already set in the supervisor's
    // env (e.g. from launchd's plist environment_variables).
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// ---- Child specs ------------------------------------------------------

interface ChildSpec {
  name: "daemon" | "dashboard" | "zero-cache";
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** One-shot setup step run before the child is spawned for the first
   *  time. Used by zero-cache to deploy permissions. */
  preStart?: () => Promise<void>;
  /** Exit codes that should trigger a fast restart (no backoff). */
  fastRestartCodes?: number[];
}

function buildSpecs(repoRoot: string): ChildSpec[] {
  const cfg = loadConfig();
  const daemonPort = resolveDaemonPort(cfg);
  const dashboardPort = resolveDashboardPort(cfg);

  return [
    {
      name: "daemon",
      cmd: "node",
      args: ["dist/index.js"],
      cwd: join(repoRoot, "services", "daemon"),
      env: {
        ...process.env,
        // Daemon resolves its own port from its env / config / constant
        // chain; passing it here is belt-and-braces.
        FRIDAY_DAEMON_PORT: String(daemonPort),
      },
    },
    {
      name: "zero-cache",
      cmd: "pnpm",
      args: ["exec", "zero-cache"],
      cwd: join(repoRoot, "services", "dashboard"),
      env: {
        ...process.env,
        ZERO_LOG_FORMAT: "json",
        // FRI-83 follow-up: the spawn-time export of ZERO_MUTATE_URL
        // is the source of truth, beating any stale value in .env.
        ZERO_MUTATE_URL: `http://localhost:${dashboardPort}/api/mutators`,
      },
      // Zero exits 14 on AutoResetSignal (replica schema-version drift
      // vs upstream Postgres); restart immediately, no backoff.
      fastRestartCodes: [14],
      async preStart(): Promise<void> {
        const schemaPath = join(
          repoRoot,
          "packages",
          "shared",
          "dist",
          "sync",
          "schema.js",
        );
        const r = spawnSync(
          "pnpm",
          ["exec", "zero-deploy-permissions", "--schema-path", schemaPath],
          { cwd: join(repoRoot, "services", "dashboard"), stdio: "inherit", env: process.env },
        );
        if (r.status !== 0) {
          throw new Error(`zero-deploy-permissions exited ${r.status}`);
        }
      },
    },
    {
      name: "dashboard",
      cmd: "node",
      args: ["server-entry.mjs"],
      cwd: join(repoRoot, "services", "dashboard"),
      env: {
        ...process.env,
        // adapter-node + server-entry.mjs both read PORT.
        PORT: String(dashboardPort),
      },
    },
  ];
}

// ---- Supervisor state -------------------------------------------------

interface ChildState {
  spec: ChildSpec;
  proc: ChildProcess | null;
  /** Wall-clock timestamps of recent exits for crash-loop detection. */
  exitTimestamps: number[];
  /** Current exponential-backoff delay (ms). Reset on clean ready. */
  backoffMs: number;
  /** True once cascade-stop begins; suppresses respawn. */
  shuttingDown: boolean;
}

const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_MAX = 5;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_CAP_MS = 8_000;
const CASCADE_STOP_DEADLINE_MS = 10_000;

const children: Map<string, ChildState> = new Map();
let supervisorShuttingDown = false;

function supervisorLogPath(): string {
  return join(LOGS_DIR, "supervisor.jsonl");
}

function logSupervisor(event: string, extra: Record<string, unknown> = {}): void {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    service: "supervisor",
    event,
    ...extra,
  });
  // Append synchronously — supervisor events are infrequent and we want
  // them durable before the process moves on (especially during shutdown).
  try {
    appendFileSync(supervisorLogPath(), line + "\n");
  } catch {
    // Last-resort: write to stderr so launchd captures it.
    process.stderr.write(line + "\n");
  }
}

// ---- Spawning + restart loop -----------------------------------------

async function spawnChild(state: ChildState): Promise<void> {
  if (state.shuttingDown || supervisorShuttingDown) return;
  const { spec } = state;
  try {
    if (spec.preStart) {
      logSupervisor("child.pre-start", { name: spec.name });
      await spec.preStart();
    }
  } catch (err) {
    logSupervisor("child.pre-start.error", {
      name: spec.name,
      message: err instanceof Error ? err.message : String(err),
    });
    scheduleRestart(state);
    return;
  }

  const logPath = getLogPath(spec.name);
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  const logStream = createWriteStream(logPath, { flags: "a" });
  // Pipe stdout + stderr into the same JSONL file. daemon/dashboard
  // already write their own structured logs; zero-cache emits JSON
  // when ZERO_LOG_FORMAT=json. Either way, stdout = log.
  const stdio: StdioOptions = ["ignore", "pipe", "pipe"];

  logSupervisor("child.spawn", {
    name: spec.name,
    cmd: spec.cmd,
    args: spec.args,
    cwd: spec.cwd,
  });
  const proc = spawn(spec.cmd, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio,
    // `detached: true` makes the child a process-group leader (pgid =
    // child.pid). Cascade-stop then does `process.kill(-child.pid,
    // 'SIGTERM')` to signal the child AND every descendant in its
    // tree — exactly closing the FRI-83 zombie gap where zero-cache's
    // worker pool survived parent SIGTERM. We don't call `unref()`
    // because we want the supervisor's event loop to track the child.
    detached: true,
  });
  state.proc = proc;
  proc.stdout?.pipe(logStream);
  proc.stderr?.pipe(logStream);

  proc.on("exit", (code, signal) => {
    state.proc = null;
    logSupervisor("child.exit", {
      name: spec.name,
      code,
      signal,
    });
    logStream.end();
    if (state.shuttingDown || supervisorShuttingDown) return;
    state.exitTimestamps.push(Date.now());
    // Trim to the crash-loop window.
    const cutoff = Date.now() - CRASH_LOOP_WINDOW_MS;
    state.exitTimestamps = state.exitTimestamps.filter((t) => t > cutoff);
    if (state.exitTimestamps.length >= CRASH_LOOP_MAX) {
      logSupervisor("child.crash-loop", {
        name: spec.name,
        exits: state.exitTimestamps.length,
        windowMs: CRASH_LOOP_WINDOW_MS,
      });
      // Exit the supervisor so launchd surfaces the failure. The
      // operator can investigate via `friday logs <name>` or
      // `friday doctor`.
      void cascadeStop(/* exitCode */ 1);
      return;
    }
    scheduleRestart(state, code ?? null);
  });
  proc.on("error", (err) => {
    logSupervisor("child.error", {
      name: spec.name,
      message: err.message,
    });
  });
}

function scheduleRestart(state: ChildState, exitCode: number | null = null): void {
  if (state.shuttingDown || supervisorShuttingDown) return;
  const fastRestart =
    exitCode !== null &&
    (state.spec.fastRestartCodes ?? []).includes(exitCode);
  const delayMs = fastRestart ? 0 : state.backoffMs;
  if (!fastRestart) {
    state.backoffMs = Math.min(state.backoffMs * 2, BACKOFF_CAP_MS);
  }
  logSupervisor("child.restart.scheduled", {
    name: state.spec.name,
    delayMs,
    fastRestart,
  });
  setTimeout(() => void spawnChild(state), delayMs);
}

// ---- Shutdown ---------------------------------------------------------

/**
 * Signal a child's entire process group. Each child was spawned with
 * `detached: true`, so its pid is also its pgid; `process.kill(-pid,
 * sig)` reaches the child plus every descendant in its tree (the
 * load-bearing semantics against FRI-83's zombie pattern, where
 * zero-cache's worker pool survived the parent's signal).
 */
function killChildGroup(state: ChildState, signal: NodeJS.Signals): void {
  const pid = state.proc?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    // ESRCH means the group already exited; that's fine. Anything else
    // is logged so the operator can see why cascade-stop fell short.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      logSupervisor("child.kill.error", {
        name: state.spec.name,
        signal,
        code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function cascadeStop(exitCode = 0): Promise<void> {
  if (supervisorShuttingDown) return;
  supervisorShuttingDown = true;
  logSupervisor("cascade-stop.begin", {});
  for (const state of children.values()) {
    state.shuttingDown = true;
  }

  // SIGTERM each child's process group. This catches grandchildren
  // (zero-cache's workers, the daemon's worker forks) because the
  // children were spawned with `detached: true`.
  for (const state of children.values()) {
    killChildGroup(state, "SIGTERM");
  }

  // Wait up to CASCADE_STOP_DEADLINE_MS for all children to exit.
  const deadline = Date.now() + CASCADE_STOP_DEADLINE_MS;
  while (Date.now() < deadline) {
    const alive = [...children.values()].filter((s) => s.proc !== null);
    if (alive.length === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Anything still alive gets SIGKILL to its process group.
  const stragglers = [...children.values()].filter((s) => s.proc !== null);
  if (stragglers.length > 0) {
    logSupervisor("cascade-stop.sigkill", {
      stragglers: stragglers.map((s) => s.spec.name),
    });
    for (const state of stragglers) {
      killChildGroup(state, "SIGKILL");
    }
  }
  logSupervisor("cascade-stop.done", { exitCode });
  process.exit(exitCode);
}

// ---- Main -------------------------------------------------------------

async function main(): Promise<void> {
  loadFridayEnv();
  const repoRoot = findRepoRoot();
  logSupervisor("startup", { pid: process.pid, repoRoot });

  const specs = buildSpecs(repoRoot);
  for (const spec of specs) {
    children.set(spec.name, {
      spec,
      proc: null,
      exitTimestamps: [],
      backoffMs: BACKOFF_INITIAL_MS,
      shuttingDown: false,
    });
  }

  // Spawn in order: daemon first (it owns migrations), then zero-cache
  // (depends on daemon-applied schema being current), then dashboard
  // (proxies WS to zero-cache via server-entry.mjs).
  for (const name of ["daemon", "zero-cache", "dashboard"] as const) {
    const state = children.get(name);
    if (!state) continue;
    await spawnChild(state);
    // Small inter-spawn gap to let daemon settle before zero-cache
    // probes its schema, and zero-cache settle before dashboard tries
    // to proxy /api/sync.
    await new Promise((r) => setTimeout(r, 500));
  }

  process.on("SIGTERM", () => void cascadeStop());
  process.on("SIGINT", () => void cascadeStop());

  // Stay alive: the event loop is kept turning by the child stdio pipes
  // and the spawn-retry timers. If every child has exited and shutdown
  // hasn't fired, the supervisor exits naturally (and launchd will
  // restart it via KeepAlive).
}

main().catch((err) => {
  logSupervisor("supervisor.fatal", {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
