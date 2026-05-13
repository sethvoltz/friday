/**
 * Kernel-side integration test for the SBPL profile (M2). Shells out to
 * `/usr/bin/sandbox-exec` with the rendered profile and verifies actual
 * EPERM behavior. The bug here lives in whether the SBPL rules we wrote
 * actually deny — not whether the renderer emits them, which is covered
 * separately. Skipped on non-Darwin / when the binary is unavailable.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderProfile } from "./sandbox-profile.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const isDarwin = process.platform === "darwin";
const hasSandboxExec = isDarwin && existsSync(SANDBOX_EXEC);

// Vitest's `it` doesn't have a stock `skipIf`; use a conditional describe
// so the kernel tests are silently absent on Linux CI.
const describeOnDarwin = hasSandboxExec ? describe : describe.skip;

function runSandboxed(
  profilePath: string,
  cmd: string,
): { code: number | null; stderr: string; stdout: string } {
  const r = spawnSync(
    SANDBOX_EXEC,
    ["-f", profilePath, "/bin/bash", "-c", cmd],
    { encoding: "utf8" },
  );
  return { code: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

describeOnDarwin("M2 kernel-enforced sandbox", () => {
  // Build a self-contained playground: a fake $HOME with subdirs that mirror
  // the paths the profile denies, plus a fake DATA_DIR with a worktree. Then
  // render the profile against THESE paths so the test never touches real
  // credentials or shell rc files. We realpath the playground because macOS
  // resolves /var/folders/... → /private/var/folders/... and SBPL matches
  // against the kernel-resolved path, not the unresolved one. Production
  // does the same via `profileInputsFor`.
  const playground = realpathSync(mkdtempSync(join(tmpdir(), "friday-sb-kernel-")));
  const fakeHome = join(playground, "home");
  const fakeDataDir = join(playground, "data");
  const fakeWorktree = join(fakeDataDir, "workspaces", "alpha");
  const fakeLogs = join(fakeDataDir, "logs");
  const siblingWorktree = join(fakeDataDir, "workspaces", "beta");

  // Create the directory tree so writes attempt creation, not enumeration.
  for (const d of [
    join(fakeHome, ".ssh"),
    join(fakeHome, ".aws"),
    join(fakeHome, "Library", "LaunchAgents"),
    fakeWorktree,
    fakeLogs,
    siblingWorktree,
  ]) {
    mkdirSync(d, { recursive: true });
  }

  const profilePath = join(playground, "test.sb");
  writeFileSync(
    profilePath,
    renderProfile({
      home: fakeHome,
      dataDir: fakeDataDir,
      worktree: fakeWorktree,
      logsDir: fakeLogs,
    }),
  );

  // Cleanup at the end via afterAll-equivalent — vitest doesn't expose
  // it in this file scope, so register a teardown via process events.
  process.on("beforeExit", () => {
    try {
      rmSync(playground, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("denies writes under fake ~/.ssh", () => {
    const target = join(fakeHome, ".ssh", "would-be-stolen");
    const r = runSandboxed(profilePath, `echo x > "${target}"`);
    expect(r.code).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it("denies writes under fake ~/.aws", () => {
    const target = join(fakeHome, ".aws", "credentials");
    const r = runSandboxed(profilePath, `echo x > "${target}"`);
    expect(r.code).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it("denies writes to fake ~/.zshrc (literal)", () => {
    const target = join(fakeHome, ".zshrc");
    const r = runSandboxed(profilePath, `echo x > "${target}"`);
    expect(r.code).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it("denies writes under fake ~/Library/LaunchAgents", () => {
    const target = join(fakeHome, "Library", "LaunchAgents", "com.evil.plist");
    const r = runSandboxed(profilePath, `echo x > "${target}"`);
    expect(r.code).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it("denies writes to a sibling worktree (peer-builder isolation)", () => {
    const target = join(siblingWorktree, "poisoned");
    const r = runSandboxed(profilePath, `echo x > "${target}"`);
    expect(r.code).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it("allows writes INSIDE the configured worktree (carve-out works)", () => {
    const target = join(fakeWorktree, "ok.txt");
    const r = runSandboxed(profilePath, `echo allowed > "${target}"`);
    expect(r.code).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  it("allows writes to the carved-out logs dir", () => {
    const target = join(fakeLogs, "ok.log");
    const r = runSandboxed(profilePath, `echo allowed > "${target}"`);
    expect(r.code).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  it("denies process-exec of /usr/bin/sandbox-exec (no profile re-invoke)", () => {
    // Try to run sandbox-exec from inside the sandbox with a permissive
    // profile. The deny should bite before the inner profile loads.
    const r = runSandboxed(
      profilePath,
      `/usr/bin/sandbox-exec -p '(version 1)(allow default)' /bin/true`,
    );
    expect(r.code).not.toBe(0);
  });

  it("denies process-exec of /usr/bin/sudo", () => {
    const r = runSandboxed(profilePath, `/usr/bin/sudo -n true`);
    expect(r.code).not.toBe(0);
  });

  it("IPC channel survives sandbox-exec → node exec", async () => {
    // The smoke test the plan calls for. Spawn a node child *through*
    // sandbox-exec and verify both directions of process.send work. If
    // NODE_CHANNEL_FD got dropped (FD_CLOEXEC bites the IPC pipe), this
    // catches it before production breaks.
    const probeScript = join(playground, "probe.mjs");
    writeFileSync(
      probeScript,
      `process.on('message', (m) => {
         process.send({ pong: m });
         setTimeout(() => process.exit(0), 50);
       });
       process.send({ ready: true });`,
    );

    const child = spawn(
      SANDBOX_EXEC,
      ["-f", profilePath, process.execPath, probeScript],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const messages: Array<Record<string, unknown>> = [];
    child.on("message", (m) => {
      messages.push(m as Record<string, unknown>);
      if ((m as { ready?: boolean }).ready) child.send({ from: "parent" });
    });
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]).toEqual({ ready: true });
    expect(messages[1]).toEqual({ pong: { from: "parent" } });
  });
});
