// Effect-layer tests for `reconcileTunnel` (FRI-166). The pure decision
// (`decideTunnelAction`) is covered exhaustively in cloudflared.test.ts; this
// suite pins the EFFECTFUL wrapper — the part the decision test can't reach:
//   - the token-fingerprint state file lifecycle (write-on-install,
//     clear-on-uninstall) under a real STATE_DIR,
//   - the split-brain invariant at the SUBPROCESS layer: serve-intent off must
//     never spawn `cloudflared service install`, no matter the token/agent
//     state (the decision test asserts the action; this asserts no install
//     subprocess is actually launched),
//   - resilience: a fingerprint write failure must not abort an
//     otherwise-successful install (the reconcile call in `friday start` sits
//     outside its try/catch).
//
// We mock only the subprocess boundary (`node:child_process`) and leave the
// filesystem real against the test's tmp STATE_DIR — same seam the rest of the
// CLI suite uses (see setup.test.ts). FRIDAY_DATA_DIR is forced to a tmpdir by
// the shared vitest-setup, so STATE_DIR resolves under it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "@friday/shared";

// Records every subprocess the reconcile spawns, and lets each test steer the
// mock's responses. Referenced lazily inside the returned spawnSync, so the
// hoisted vi.mock factory is fine (mirrors setup.test.ts).
const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
const ctl = {
  loadedStatus: 1, // `launchctl print` exit code: 0 = cloudflared job loaded
  cloudflaredOnPath: true, // `which cloudflared` success
  installStatus: 0, // `cloudflared service install` exit code
};

vi.mock("node:child_process", () => ({
  spawnSync: (cmd: string, args: string[] = []) => {
    spawnCalls.push({ cmd, args });
    if (cmd === "launchctl" && args[0] === "print") return { status: ctl.loadedStatus };
    if (cmd === "which") return { status: ctl.cloudflaredOnPath ? 0 : 1 };
    if (cmd === "brew") return { status: 1 }; // no brew-managed cloudflared
    if (cmd === "cloudflared" && args[0] === "service" && args[1] === "install")
      return { status: ctl.installStatus, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  },
}));

const { reconcileTunnel, sha256 } = await import("./cloudflared.js");

const FINGERPRINT = join(STATE_DIR, "cloudflared-token.sha256");

function installCallHappened(): boolean {
  return spawnCalls.some(
    (c) => c.cmd === "cloudflared" && c.args[0] === "service" && c.args[1] === "install",
  );
}

beforeEach(() => {
  spawnCalls.length = 0;
  ctl.loadedStatus = 1;
  ctl.cloudflaredOnPath = true;
  ctl.installStatus = 0;
  // FINGERPRINT may be left as a directory by the resilience test — clear both.
  rmSync(FINGERPRINT, { force: true, recursive: true });
});

afterEach(() => {
  rmSync(FINGERPRINT, { force: true, recursive: true });
});

describe("reconcileTunnel (effect layer)", () => {
  it("install path: runs `cloudflared service install <token>` and persists the token fingerprint", () => {
    ctl.loadedStatus = 1; // agent not loaded → install
    const res = reconcileTunnel({ serve: true, token: "super-secret-connector-token" });

    expect(res).toMatchObject({ action: "install", ok: true });
    const installCall = spawnCalls.find((c) => c.cmd === "cloudflared" && c.args[1] === "install");
    expect(installCall?.args).toEqual(["service", "install", "super-secret-connector-token"]);
    // Fingerprint persisted = sha256(token), so a later rotation is detectable.
    expect(existsSync(FINGERPRINT)).toBe(true);
    expect(readFileSync(FINGERPRINT, "utf8").trim()).toBe(sha256("super-secret-connector-token"));
  });

  it("split-brain guard at the subprocess layer: serve-intent off NEVER spawns `service install`, even with a token + a loaded agent", () => {
    ctl.loadedStatus = 0; // agent currently loaded
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(FINGERPRINT, "stale-fingerprint\n"); // a leftover fingerprint

    const res = reconcileTunnel({ serve: false, token: "prod-connector-token" });

    expect(res).toMatchObject({ action: "uninstall", ok: true });
    expect(installCallHappened()).toBe(false);
    // Teardown clears the fingerprint so a later install re-records it.
    expect(existsSync(FINGERPRINT)).toBe(false);
  });

  it("uninstall path: token removed (serve still on) + agent loaded → tears down and clears the fingerprint, no install", () => {
    ctl.loadedStatus = 0; // loaded
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(FINGERPRINT, "old\n");

    const res = reconcileTunnel({ serve: true, token: undefined });

    expect(res).toMatchObject({ action: "uninstall", ok: true });
    expect(installCallHappened()).toBe(false);
    expect(existsSync(FINGERPRINT)).toBe(false);
  });

  it("idempotent: serve + token + already-loaded agent with the matching fingerprint → noop, no install subprocess", () => {
    ctl.loadedStatus = 0; // loaded
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(FINGERPRINT, sha256("tok") + "\n"); // fingerprint matches current token

    const res = reconcileTunnel({ serve: true, token: "tok" });

    expect(res).toMatchObject({ action: "noop", ok: true });
    expect(installCallHappened()).toBe(false);
  });

  it("rotation: serve + token + loaded agent whose fingerprint differs → reinstall (runs service install with the new token)", () => {
    ctl.loadedStatus = 0; // loaded
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(FINGERPRINT, sha256("old-token") + "\n");

    const res = reconcileTunnel({ serve: true, token: "new-token" });

    expect(res).toMatchObject({ action: "reinstall", ok: true });
    expect(installCallHappened()).toBe(true);
    expect(readFileSync(FINGERPRINT, "utf8").trim()).toBe(sha256("new-token"));
  });

  it("cloudflared not on PATH → soft skip (ok:false, skipped:true), no fingerprint written", () => {
    ctl.loadedStatus = 1; // not loaded → would install
    ctl.cloudflaredOnPath = false;

    const res = reconcileTunnel({ serve: true, token: "tok" });

    expect(res).toMatchObject({ action: "install", ok: false, skipped: true });
    expect(existsSync(FINGERPRINT)).toBe(false);
  });

  it("resilience (Finding 1): a fingerprint-write failure does NOT abort an otherwise-successful install", () => {
    // Make the fingerprint PATH a directory so writeFileSync throws EISDIR —
    // a real filesystem failure, no fs mocking. install itself still succeeds.
    mkdirSync(STATE_DIR, { recursive: true });
    mkdirSync(FINGERPRINT, { recursive: true });
    ctl.loadedStatus = 1; // not loaded → install

    let res!: ReturnType<typeof reconcileTunnel>;
    expect(() => {
      res = reconcileTunnel({ serve: true, token: "tok" });
    }).not.toThrow();
    // The install completed; only the optimization (fingerprint) was lost.
    expect(res).toMatchObject({ action: "install", ok: true });
    expect(installCallHappened()).toBe(true);
  });
});
