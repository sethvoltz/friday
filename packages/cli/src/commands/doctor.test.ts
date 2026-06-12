// Tests for the `friday doctor` interactive-shell node probe — the check that
// catches "fnm installed but its shell hook never added", which silently kills
// every agent turn (the prod→Intel migration failure). The probe is the bug's
// detector, so it must load-bear: report ok ONLY when `$SHELL -ilc` actually
// runs `node -e` and emits a version, and fail (not crash) otherwise.

import { describe, expect, it, vi } from "vitest";
import type { spawnSync as SpawnSync } from "node:child_process";

// For the runDependencies integration test below: stub every subprocess so the
// section runs offline. All checks resolve to fail/absent, which is fine — the
// point is that EVERY resolved row was declared (a `box.resolve()` for an
// undeclared row throws "no declared row", which is exactly the bug this guards).
vi.mock("node:child_process", () => ({
  spawnSync: () => ({ status: 1, stdout: "", stderr: "" }),
}));

import { probeInteractiveShellNode, runDependencies } from "./doctor.js";

/** A fake spawnSync that records its invocation and returns a canned result. */
function fakeSpawn(result: { status: number | null; stdout: string }) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { status: result.status, stdout: result.stdout } as ReturnType<typeof SpawnSync>;
  }) as unknown as typeof SpawnSync;
  return { fn, calls };
}

describe("probeInteractiveShellNode", () => {
  it("ok when the interactive shell runs node -e and emits the marked version", () => {
    const { fn, calls } = fakeSpawn({ status: 0, stdout: "__friday_node__v22.21.1" });
    const res = probeInteractiveShellNode(fn, "/bin/zsh");

    expect(res.ok).toBe(true);
    expect(res.shell).toBe("/bin/zsh");
    expect(res.detail).toContain("v22.21.1");
    // It must probe the INTERACTIVE shell (-ilc) and actually run node, not `which`.
    expect(calls[0]?.cmd).toBe("/bin/zsh");
    expect(calls[0]?.args[0]).toBe("-ilc");
    expect(calls[0]?.args[1]).toContain("node -e");
  });

  it("ok even when the login rc prints a banner to stdout before the version (marker isolates it)", () => {
    // The regression the marker exists to prevent: a `.zshrc` that echoes a
    // banner would defeat a bare `^v…` anchor and false-fail on a healthy box.
    const { fn } = fakeSpawn({
      status: 0,
      stdout: "fastfetch banner line 1\nwelcome\n__friday_node__v22.21.1",
    });
    expect(probeInteractiveShellNode(fn, "/bin/zsh").ok).toBe(true);
  });

  it("unverified (not fail) for a shell whose -ilc invocation differs (fish)", () => {
    let spawned = false;
    const fn = (() => {
      spawned = true;
      return { status: 0, stdout: "" };
    }) as unknown as typeof SpawnSync;
    const res = probeInteractiveShellNode(fn, "/opt/homebrew/bin/fish");
    expect(res.unverified).toBe(true);
    expect(res.ok).toBe(false);
    // It must NOT run a wrong `-ilc` invocation against fish.
    expect(spawned).toBe(false);
  });

  it("fails (does not throw) when node is not on the interactive PATH (exit 127)", () => {
    const { fn } = fakeSpawn({ status: 127, stdout: "" });
    const res = probeInteractiveShellNode(fn, "/bin/zsh");
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("not resolvable");
  });

  it("fails when the shell exits 0 but emits no version (e.g. a stray rc echo, not node)", () => {
    const { fn } = fakeSpawn({ status: 0, stdout: "hello from .zshrc\n" });
    const res = probeInteractiveShellNode(fn, "/bin/zsh");
    expect(res.ok).toBe(false);
  });

  it("treats a null exit status (spawn failure / timeout) as a failure", () => {
    const { fn } = fakeSpawn({ status: null, stdout: "" });
    expect(probeInteractiveShellNode(fn, "/bin/zsh").ok).toBe(false);
  });
});

describe("runDependencies — every resolved row is declared (LiveBox contract)", () => {
  it("completes without throwing 'no declared row' and includes the 'node in shell' row", async () => {
    // Regression: #261 added `box.resolve("node in shell", …)` but forgot to
    // `box.declare()` it, so doctor threw at runtime. If any resolved row is
    // undeclared, runDependencies throws here and the test fails.
    const checks = await runDependencies();
    const labels = checks.map((c) => c.label);
    expect(labels).toContain("node in shell");
    // Sanity: the other declared rows are present too (so the box stayed intact).
    expect(labels).toEqual(
      expect.arrayContaining(["fnm", "node version", "claude CLI", "node in shell"]),
    );
  });
});
