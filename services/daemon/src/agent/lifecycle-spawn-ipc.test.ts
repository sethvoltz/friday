/**
 * Smoke test for the production spawn chain (M2 + M5). Verifies IPC
 * survives the full chain: spawn → /usr/bin/sandbox-exec → /bin/bash
 * (applying ulimits) → exec node. If FD_CLOEXEC bites the IPC pipe or
 * NODE_CHANNEL_FD is dropped across either exec, this test fails — and
 * production silently breaks ("daemon thinks worker spawned but no IPC
 * ever arrives"). The plan calls this out as the critical regression
 * check for PR 2.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const hasSandboxExec =
  process.platform === "darwin" && existsSync(SANDBOX_EXEC);
const describeOnDarwin = hasSandboxExec ? describe : describe.skip;

const ULIMIT_PRELUDE = `ulimit -t 3600; ulimit -n 4096; exec "$@"`;

async function runRoundTrip(args: string[]): Promise<{
  ready: boolean;
  pong: unknown;
  exitCode: number | null;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let ready = false;
    let pong: unknown = null;
    child.on("message", (m: { ready?: boolean; pong?: unknown }) => {
      if (m.ready) {
        ready = true;
        child.send({ from: "parent" });
      } else if (m.pong !== undefined) {
        pong = m.pong;
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ ready, pong, exitCode: code });
    });
  });
}

describeOnDarwin("M2 + M5 spawn chain preserves IPC", () => {
  // Build a permissive profile so the test isn't gated on having a real
  // worktree available. The point is to verify the IPC contract through
  // the exec chain, not to test SBPL rules (covered by
  // sandbox-profile-kernel.test.ts).
  const playground = realpathSync(
    mkdtempSync(join(tmpdir(), "friday-ipc-smoke-")),
  );
  const profilePath = join(playground, "permissive.sb");
  writeFileSync(profilePath, `(version 1)\n(allow default)\n`);

  const stubWorker = join(playground, "stub-worker.mjs");
  writeFileSync(
    stubWorker,
    `process.on('message', (m) => {
       process.send({ pong: m });
       setTimeout(() => process.exit(0), 50);
     });
     process.send({ ready: true });
    `,
  );

  it("IPC survives sandbox-exec → bash (ulimit) → node", async () => {
    // Mirror the production invocation from lifecycle.ts:
    //   spawn('sandbox-exec', ['-f', profile, '/bin/bash', '-c',
    //          ULIMIT_PRELUDE, '--', node, ...execArgv, WORKER_PATH], ...)
    //
    // execArgv forwarding is critical for `tsx watch` dev: the parent has
    // `--import tsx/esm` (or equivalent) so the worker's plain `node` can
    // resolve TypeScript source. Without this the worker errors with
    // MODULE_NOT_FOUND on `.ts` files masquerading as `.js`.
    const result = await runRoundTrip([
      SANDBOX_EXEC,
      "-f",
      profilePath,
      "/bin/bash",
      "-c",
      ULIMIT_PRELUDE,
      "--",
      process.execPath,
      ...process.execArgv,
      stubWorker,
    ]);
    expect(result.ready).toBe(true);
    expect(result.pong).toEqual({ from: "parent" });
    expect(result.exitCode).toBe(0);
  });

  it("IPC survives bash (ulimit) → node when sandbox is bypassed", async () => {
    // Non-builder spawn path: no sandbox-exec, just bash + ulimit.
    const result = await runRoundTrip([
      "/bin/bash",
      "-c",
      ULIMIT_PRELUDE,
      "--",
      process.execPath,
      ...process.execArgv,
      stubWorker,
    ]);
    expect(result.ready).toBe(true);
    expect(result.pong).toEqual({ from: "parent" });
    expect(result.exitCode).toBe(0);
  });

  it("ulimit values actually apply inside the worker process", async () => {
    // Run a probe that calls `ulimit -t` and `ulimit -n` inside its own
    // shell and writes them via IPC — proves the prelude took effect, not
    // just that the chain didn't crash.
    const probe = join(playground, "ulimit-probe.mjs");
    writeFileSync(
      probe,
      `import { execSync } from 'node:child_process';
       const cpu = execSync('ulimit -t', { shell: '/bin/bash' }).toString().trim();
       const nofile = execSync('ulimit -n', { shell: '/bin/bash' }).toString().trim();
       process.send({ ready: true, cpu, nofile });
       process.on('message', () => setTimeout(() => process.exit(0), 20));
      `,
    );
    const result = await new Promise<{ cpu: string; nofile: string }>(
      (resolve, reject) => {
        const child = spawn(
          "/bin/bash",
          ["-c", ULIMIT_PRELUDE, "--", process.execPath, probe],
          { stdio: ["ignore", "ignore", "ignore", "ipc"] },
        );
        child.on("message", (m: { cpu?: string; nofile?: string }) => {
          if (m.cpu) {
            resolve({ cpu: m.cpu, nofile: m.nofile ?? "" });
            child.send({ exit: true });
          }
        });
        child.on("error", reject);
      },
    );
    expect(result.cpu).toBe("3600");
    expect(result.nofile).toBe("4096");
  });
});
