/**
 * FRI-150: shell-env capture at daemon boot.
 *
 * The MCP SDK's `StdioClientTransport` deliberately allowlists env vars at
 * the spawn boundary — only HOME/LOGNAME/PATH/SHELL/TERM/USER from
 * `process.env` pass through to MCP children
 * (`@modelcontextprotocol/sdk@1.29.0/dist/esm/client/stdio.js:8-24`). On a
 * launchd-spawned daemon, that PATH is launchd's minimal floor, and a
 * clean install (no brew-installed Node) can't resolve `node`/`npx` in any
 * spawned MCP. Baking PATH into the plist (the closed PR #161 approach)
 * doesn't help — the allowlist filter still strips everything else
 * (FNM_DIR, NVM_DIR, asdf shims, etc.).
 *
 * Pattern adopted from VS Code's `src/vs/platform/shell/node/shellEnv.ts`:
 * cold-start spawn the user's `$SHELL` as an interactive login shell, ask
 * Node to JSON.stringify(process.env), parse, cache. Then in
 * `services/daemon/src/mcp/builder.ts` we pass the captured env as the
 * per-server `env` field — the SDK does
 * `{ ...getDefaultEnvironment(), ...config.env }`, so our captured env
 * supersets the allowlist and any manifest `env` still wins on top.
 *
 * The capture lives at daemon boot, NOT in the supervisor shim. The shim
 * only needs to find Node (via `FRIDAY_FNM_BIN`); PATH propagation for
 * MCP children is a daemon-layer concern.
 *
 * Failure mode is well-understood territory (VS Code issue #113869,
 * "Unable to resolve your shell environment in a reasonable time"): on
 * timeout, non-zero shell exit, missing markers, or unparseable JSON we
 * fall back to `process.env` and emit a structured warning. Daemon boot
 * never blocks on this.
 *
 * Worker propagation: the daemon's singleton is JSON-serialized into
 * `FRIDAY_RESOLVED_SHELL_ENV_JSON` at worker fork time (lifecycle.ts);
 * the worker entry parses it on startup via `loadResolvedShellEnvFromJson`
 * to seed its own singleton. `process.env` itself is NOT mutated — we
 * keep the captured env quarantined so it can't clobber daemon-owned
 * vars (`BETTER_AUTH_SECRET`, `ZERO_AUTH_SECRET`, `FRIDAY_DATA_DIR`, …).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { logger } from "./log.js";

export const SHELL_ENV_ENV_VAR = "FRIDAY_RESOLVED_SHELL_ENV_JSON";
export const SHELL_ENV_TIMEOUT_ENV_VAR = "FRIDAY_SHELL_ENV_TIMEOUT_MS";
const START_MARKER = "__FRIDAY_SHELL_ENV_START__";
const END_MARKER = "__FRIDAY_SHELL_ENV_END__";
const DEFAULT_TIMEOUT_MS = 5000;
/**
 * Soft-cap on `serializeShellEnvForWorker`. macOS `ARG_MAX` is ~256 KB total
 * for argv+envp passed to `execve`; a captured shell env over ~100 KB
 * starts crowding the per-worker fork. F5: skip the env-var forwarding past
 * this threshold and log; the worker hits its `not-captured` sentinel and
 * falls back to a process.env snapshot. Override via the
 * `FRIDAY_SHELL_ENV_WORKER_MAX_BYTES` env var (numeric, byte count).
 */
const DEFAULT_WORKER_PAYLOAD_MAX_BYTES = 100 * 1024;
const WORKER_PAYLOAD_MAX_BYTES_ENV_VAR = "FRIDAY_SHELL_ENV_WORKER_MAX_BYTES";

/**
 * B1: secret-shaped keys we never let cross the daemon ↔ shell-child or
 * daemon ↔ MCP-child boundary. The pattern catches `*_SECRET`, `*_TOKEN`,
 * `*_API_KEY`, `*_PASSWORD`, `*_PASSWD`, `*_PASSPHRASE`, `*_PRIVATE_KEY`,
 * `*_CREDENTIAL[S]`. Reviewer-named keys (BETTER_AUTH_SECRET,
 * ZERO_AUTH_SECRET, ZERO_ADMIN_PASSWORD, LINEAR_API_KEY, ANTHROPIC_API_KEY)
 * are all matched by the suffix rule.
 *
 * Exported for use in tests + so adversarial reviewers can audit the
 * filter shape without spelunking through the module.
 */
export const SECRET_LIKE_KEY_RE =
  /(?:^|_)(SECRET|SECRETS|TOKEN|API_KEY|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_KEY|CREDENTIAL|CREDENTIALS)$/i;

/**
 * B1: explicit secret-bearing keys whose name doesn't match the regex above
 * but which we know carry credentials in their value (e.g. Postgres URLs
 * with embedded passwords).
 */
export const EXPLICIT_SECRET_KEYS = new Set<string>(["DATABASE_URL", "ZERO_UPSTREAM_DB"]);

/**
 * B1: predicate the in/out gates use to decide whether a key carries a
 * secret. Exported for tests.
 */
export function isSecretKey(key: string): boolean {
  return EXPLICIT_SECRET_KEYS.has(key) || SECRET_LIKE_KEY_RE.test(key);
}

/**
 * B1: strip secret-shaped keys from an env map. Used both as the OUTPUT
 * gate (after parsing the captured JSON, before caching) and as the
 * INPUT gate (when handing `process.env` to the spawned shell child).
 * Belt-and-suspenders: either gate failing alone would have been the
 * leak, both have to fail simultaneously for a regression to land.
 */
export function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!isSecretKey(k)) out[k] = v;
  }
  return out;
}

/**
 * B1: NodeJS.ProcessEnv-typed variant for `child_process.spawn`'s `env`
 * field. Filters secrets out of `process.env` before handing it to the
 * spawned shell — the shell child never sees `BETTER_AUTH_SECRET` /
 * `LINEAR_API_KEY` / etc., so a malicious `.zshrc` can't exfiltrate
 * them via `JSON.stringify(process.env)` or any other mechanism.
 */
export function sanitizedProcessEnvForChild(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && !isSecretKey(k)) out[k] = v;
  }
  return out;
}

export type ShellEnvSource = "shell" | "process";

export interface ShellEnvResult {
  /** The resolved env. On `source === "process"` this is a snapshot of process.env. */
  env: Record<string, string>;
  source: ShellEnvSource;
  /** Resolved shell path on success; the path we attempted on capture failure; undefined when we couldn't detect any shell at all. */
  shell?: string;
  /** Reason for fallback when `source === "process"`. */
  fallbackReason?: string;
  durationMs: number;
}

let cached: ShellEnvResult | undefined;

/** Test-only: clear the singleton. Prefixed underscore to match repo idioms. */
export function __resetForTests(): void {
  cached = undefined;
}

/**
 * Return the cached shell-env result. Falls back to a `process.env`
 * snapshot if `captureShellEnv` was never called (defensive — every
 * caller should rely on the daemon boot path having seeded it).
 */
export function getResolvedShellEnv(): ShellEnvResult {
  if (cached) return cached;
  return {
    env: snapshotProcessEnv(),
    source: "process",
    fallbackReason: "not-captured",
    durationMs: 0,
  };
}

/**
 * JSON-serialize the singleton. Returns "" when no capture has run.
 *
 * Prefer `serializeShellEnvForWorker()` for the worker-fork path — it
 * adds the F5 ARG_MAX guard. This raw serializer exists for tests that
 * need the unguarded shape.
 */
export function serializeShellEnv(): string {
  if (!cached) return "";
  return JSON.stringify(cached);
}

/**
 * F5: serialize the captured singleton for worker-fork forwarding via
 * `FRIDAY_RESOLVED_SHELL_ENV_JSON`. macOS `ARG_MAX` is ~256 KB total for
 * argv+envp passed to `execve`; a captured shell env above ~100 KB
 * crowds the worker fork and risks `E2BIG`. If we exceed
 * `DEFAULT_WORKER_PAYLOAD_MAX_BYTES` (override via
 * `FRIDAY_SHELL_ENV_WORKER_MAX_BYTES`), drop the forwarding entirely and
 * log `daemon.shell-env.worker-payload-too-large`. The worker then hits
 * its `not-captured` sentinel and falls back to a process.env snapshot
 * (a still-functional degraded mode).
 *
 * Returns "" both when there's no capture AND when the payload exceeds
 * the cap — callers always treat "" as "skip the env var", so the
 * worker fork path stays uniform.
 */
export function serializeShellEnvForWorker(): string {
  const raw = serializeShellEnv();
  if (!raw) return "";
  const cap = readWorkerPayloadCap();
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > cap) {
    logger.log("warn", "daemon.shell-env.worker-payload-too-large", {
      bytes,
      cap,
      // Help future debuggers narrow it down without dumping the whole env.
      keyCount: cached ? Object.keys(cached.env).length : 0,
    });
    return "";
  }
  return raw;
}

function readWorkerPayloadCap(): number {
  const raw = process.env[WORKER_PAYLOAD_MAX_BYTES_ENV_VAR];
  if (!raw) return DEFAULT_WORKER_PAYLOAD_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WORKER_PAYLOAD_MAX_BYTES;
}

/**
 * Worker-side counterpart of `serializeShellEnv`: parse the JSON payload
 * the daemon forwarded and seed the singleton. Empty/missing payload is
 * tolerated — the worker still gets a `process.env` fallback via
 * `getResolvedShellEnv`. Malformed payload is logged but doesn't throw.
 */
export function loadResolvedShellEnvFromJson(json: string | undefined): void {
  if (!json) return;
  try {
    const parsed = JSON.parse(json) as ShellEnvResult;
    if (!parsed || typeof parsed !== "object" || !parsed.env || typeof parsed.env !== "object") {
      logger.log("warn", "daemon.shell-env.deserialize.invalid", {
        reason: "shape-mismatch",
      });
      return;
    }
    // B1 worker-side gate: even though the daemon already filtered secrets
    // before serializing, re-filter on load. Defends against a stale env
    // var hand-set by an operator or a future code path that forgot to
    // sanitize before serializing.
    parsed.env = sanitizeEnv(parsed.env);
    cached = parsed;
  } catch (err) {
    logger.log("warn", "daemon.shell-env.deserialize.invalid", {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface CaptureOptions {
  /** Override the env var-derived timeout. */
  timeoutMs?: number;
  /** Override shell detection (testing only). */
  shellOverride?: string;
  /** Inject a spawn implementation (testing only). */
  spawnImpl?: typeof spawn;
  /** Inject an existsSync implementation (testing only). */
  existsImpl?: typeof existsSync;
}

/**
 * Run the user's `$SHELL` once to capture the env it would hand a fresh
 * interactive login shell. Cached as a module singleton — call once at
 * boot. On any failure mode, returns a `process.env` snapshot and emits
 * a `daemon.shell-env.fallback` warning event.
 */
export async function captureShellEnv(opts: CaptureOptions = {}): Promise<ShellEnvResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? readTimeoutFromEnv() ?? DEFAULT_TIMEOUT_MS;
  const exists = opts.existsImpl ?? existsSync;
  const spawnFn = opts.spawnImpl ?? spawn;
  const shell = opts.shellOverride ?? resolveShellPath(exists);

  if (!shell) {
    cached = fallback({ reason: "no-shell-detected", start });
    return cached;
  }

  try {
    const env = await runCapture(shell, timeoutMs, spawnFn);
    const durationMs = Date.now() - start;
    const newKeys = Object.keys(env)
      .filter((k) => !(k in process.env))
      .sort();
    cached = { env, source: "shell", shell, durationMs };
    // F4: do NOT log the full PATH at info level — a user grepping their
    // launchd.out.log shouldn't see their entire directory layout on
    // every daemon boot. `pathLength` + `newKeyCount` + `shell` is
    // enough breadcrumb to confirm the capture worked.
    logger.log("info", "daemon.shell-env.captured", {
      shell,
      durationMs,
      newKeyCount: newKeys.length,
      pathLength: typeof env.PATH === "string" ? env.PATH.length : 0,
    });
    return cached;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    cached = fallback({ reason, start, shell });
    return cached;
  }
}

function readTimeoutFromEnv(): number | undefined {
  const raw = process.env[SHELL_ENV_TIMEOUT_ENV_VAR];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function snapshotProcessEnv(): Record<string, string> {
  // B1: the fallback path also feeds MCP-child `env`, so secrets must be
  // stripped here too. Otherwise a shell-capture failure would still leak
  // BETTER_AUTH_SECRET, LINEAR_API_KEY, … through `getResolvedShellEnv()`
  // into spawned MCP children.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && !isSecretKey(k)) out[k] = v;
  }
  return out;
}

function fallback(input: { reason: string; start: number; shell?: string }): ShellEnvResult {
  const durationMs = Date.now() - input.start;
  logger.log("warn", "daemon.shell-env.fallback", {
    reason: input.reason,
    shell: input.shell,
    durationMs,
  });
  return {
    env: snapshotProcessEnv(),
    source: "process",
    shell: input.shell,
    fallbackReason: input.reason,
    durationMs,
  };
}

/**
 * Detect the user's interactive shell. `$SHELL=/bin/sh` on weird launchd
 * boots is a useless signal — sh won't source zsh/bash rc files — so we
 * explicitly prefer `/bin/zsh`, then `/bin/bash`, before falling back to
 * a non-sh `$SHELL`.
 */
function resolveShellPath(exists: typeof existsSync): string | undefined {
  const fromEnv = process.env.SHELL;
  const isUseless = !fromEnv || fromEnv === "/bin/sh" || !exists(fromEnv);
  if (!isUseless) return fromEnv;
  for (const candidate of ["/bin/zsh", "/bin/bash"]) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

interface ShellInvocation {
  flags: string[];
  script: string;
}

function buildInvocation(shellPath: string): ShellInvocation {
  const name = basename(shellPath);
  const script = `node -e 'process.stdout.write("\\n${START_MARKER}\\n"+JSON.stringify(process.env)+"\\n${END_MARKER}\\n")'`;
  // VS Code shell-flag matrix from src/vs/platform/shell/node/shellEnv.ts.
  // bash/zsh/sh need both -i (run .bashrc/.zshrc) and -l (run .profile/.zprofile)
  // — neither alone covers what a fresh terminal session sees.
  switch (name) {
    case "pwsh":
    case "powershell":
      // PowerShell's quoting differs enough that we use a single-quoted JSON
      // emitter. `Out-Host` is the closest stdout-write equivalent for the
      // marker / JSON payload.
      return {
        flags: ["-Login", "-Command"],
        script: `node -e "process.stdout.write('\\n${START_MARKER}\\n'+JSON.stringify(process.env)+'\\n${END_MARKER}\\n')"`,
      };
    case "tcsh":
    case "csh":
      return { flags: ["-ic"], script };
    case "nu":
    case "fish":
      // NIT-2: nushell + fish parse their short flags individually — `-ilc`
      // is read as a single unknown flag and the shell errors out. VS Code's
      // matrix passes them as separate arguments.
      return { flags: ["-i", "-l", "-c"], script };
    case "bash":
    case "zsh":
    case "sh":
    default:
      return { flags: ["-ilc"], script };
  }
}

function runCapture(
  shellPath: string,
  timeoutMs: number,
  spawnFn: typeof spawn,
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const { flags, script } = buildInvocation(shellPath);
    const child = spawnFn(shellPath, [...flags, script], {
      stdio: ["ignore", "pipe", "pipe"],
      // B1 INPUT gate: hand a sanitized env to the spawned shell so
      // `JSON.stringify(process.env)` (or any other rc-file behavior)
      // cannot exfiltrate Friday's secrets. Paired with the OUTPUT
      // gate inside the parse path below — both must fail simultaneously
      // for a secret to leak through to an MCP child.
      env: sanitizedProcessEnvForChild(),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (op: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      op();
    };

    const timer = setTimeout(() => {
      finish(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
        reject(new Error(`shell-env capture timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (err: Error) => {
      finish(() => reject(err));
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      if (code !== 0) {
        finish(() => {
          const tail = stderr.trim().slice(-200);
          reject(
            new Error(
              `shell exited code=${code} signal=${signal ?? "none"}${tail ? `; stderr: ${tail}` : ""}`,
            ),
          );
        });
        return;
      }
      // F3: use `lastIndexOf` for BOTH markers so a noisy rc-file that
      // happens to echo the literal marker string before the real
      // payload (corporate startup banners, sourced log scripts, etc.)
      // can't beat the real markers. The real `JSON.stringify(process.env)`
      // payload is always the last marker pair emitted.
      const startIdx = stdout.lastIndexOf(START_MARKER);
      const endIdx = stdout.lastIndexOf(END_MARKER);
      if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
        finish(() => reject(new Error("markers not found in shell output")));
        return;
      }
      const json = stdout.slice(startIdx + START_MARKER.length, endIdx).trim();
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        // B1 OUTPUT gate: strip secret-shaped keys from the parsed env
        // before resolving. Even if the spawned shell somehow re-introduces
        // a secret (rc file exports `BETTER_AUTH_SECRET=foo` on its own),
        // it never reaches the cache or any MCP child's `env`.
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string" && !isSecretKey(k)) env[k] = v;
        }
        finish(() => resolve(env));
      } catch (err) {
        finish(() =>
          reject(
            new Error(`JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`),
          ),
        );
      }
    });
  });
}
