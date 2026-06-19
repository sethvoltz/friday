/**
 * The supervision aliases dispatch to launchctl, not brew (FRI-146 /
 * ADR-034, AC#13). `friday start` bootstraps/kickstarts, `friday stop`
 * boots out, `friday restart` kickstarts. The launchd helper is mocked so
 * the real launchctl never runs; we assert which helper each command calls.
 *
 * Also a static-source guard (AC#12/#13): status.ts + doctor.ts must no
 * longer reference the retired brew-generated launchd label, and none of the
 * supervision-alias sources may shell out to brew. The forbidden literals
 * are assembled from fragments so the AC#12 repo-wide grep stays clean
 * (a verbatim literal here would itself trip the grep).
 *
 * FRIDAY_DATA_DIR is set to a scratch tmp dir before any @friday/shared
 * import (data-dir binding rule).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = mkdtempSync(join(tmpdir(), "friday-supervision-home-"));
process.env.HOME = HOME;
process.env.FRIDAY_DATA_DIR = join(HOME, ".friday");

// Mock the launchd helper: spy every entry point, no real launchctl.
const bootstrap = vi.fn();
const bootout = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
const kickstart = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
const isBootstrapped = vi.fn(() => false);
vi.mock("../lib/launchd.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/launchd.js")>();
  return { ...actual, bootstrap, bootout, kickstart, isBootstrapped };
});

// `friday start` runs a read-only checkDeps() before bootstrapping (dep
// preflight). Mock it healthy by default so the launchd-dispatch assertions
// reach bootstrap; the deps-missing gate flips it in its own test below.
const checkDeps = vi.fn(async () => ({ ok: true, hard: [], soft: [] }));
vi.mock("../lib/deps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/deps.js")>();
  return { ...actual, checkDeps };
});

const { startCommand } = await import("./start.js");
const { stopCommand } = await import("./stop.js");
const { restartCommand } = await import("./restart.js");

type Runnable = { run: (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => unknown };

async function runCmd(cmd: unknown, args: Record<string, unknown> = {}): Promise<void> {
  await (cmd as unknown as Runnable).run({ args, rawArgs: [] });
}

describe("supervision aliases → launchctl (AC#13)", () => {
  beforeEach(() => {
    bootstrap.mockClear();
    bootout.mockClear();
    kickstart.mockClear();
    isBootstrapped.mockReset();
    isBootstrapped.mockReturnValue(false);
    checkDeps.mockReset();
    checkDeps.mockResolvedValue({ ok: true, hard: [], soft: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("friday start goes through launchd.bootstrap when deps are healthy (rewrites plist + boots or kickstarts)", async () => {
    // With deps healthy (mocked), start.ts calls launchd.bootstrap so that
    // updates to the plist shape between releases (ProgramArguments /
    // EnvironmentVariables edits) reach an already-loaded job — a bare
    // kickstart would never rewrite the plist. launchd.bootstrap internally
    // branches on isBootstrapped: writePlist then either bootstrap or
    // kickstart. We pin start.ts's contract here (calls bootstrap); the
    // internal branching is covered in launchd's own tests.
    isBootstrapped.mockReturnValue(false);
    await runCmd(startCommand, {});
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(bootout).not.toHaveBeenCalled();
    bootstrap.mockClear();
    isBootstrapped.mockReturnValue(true);
    await runCmd(startCommand, {});
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(bootout).not.toHaveBeenCalled();
  });

  it("friday start REFUSES to bootstrap when a hard dep is missing (dep preflight)", async () => {
    // The gate: rather than bootstrap a supervisor that would just park on a
    // missing hard dep, start.ts prints the remedy and exits non-zero WITHOUT
    // bootstrapping.
    checkDeps.mockResolvedValue({
      ok: false,
      hard: [{ name: "pgvector:extension", present: false, remedy: "run `friday provision`" }],
      soft: [],
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    try {
      await expect(runCmd(startCommand, {})).rejects.toThrow("process.exit(1)");
      expect(bootstrap).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("friday stop boots out", async () => {
    await runCmd(stopCommand, {});
    expect(bootout).toHaveBeenCalledTimes(1);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(kickstart).not.toHaveBeenCalled();
  });

  it("friday restart kickstarts", async () => {
    await runCmd(restartCommand, {});
    expect(kickstart).toHaveBeenCalledTimes(1);
    expect(bootout).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
  });
});

describe("no brew / retired-label refs in supervision sources (AC#12/#13)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  function src(name: string): string {
    return readFileSync(join(here, name), "utf8");
  }
  // Assembled from fragments so this test file doesn't itself match the
  // AC#12 grep for these literals.
  const RETIRED_LABEL = ["homebrew", "mxcl", "friday"].join(".");
  const FORMULA_REF = ["sethvoltz", "friday", "friday"].join("/");

  it("status.ts no longer references the retired label and queries com.sethvoltz.friday", () => {
    const s = src("status.ts");
    expect(s).not.toContain(RETIRED_LABEL);
    // Queries via the shared FRIDAY_LAUNCHD_LABEL constant.
    expect(s).toContain("FRIDAY_LAUNCHD_LABEL");
  });

  it("doctor.ts no longer references the retired label or the friday formula", () => {
    const s = src("doctor.ts");
    expect(s).not.toContain(RETIRED_LABEL);
    expect(s).not.toContain(FORMULA_REF);
  });

  it("start/stop/restart sources contain no `brew services …friday`", () => {
    for (const f of ["start.ts", "stop.ts", "restart.ts"]) {
      const s = src(f);
      expect(s, `${f} must not shell out to brew`).not.toMatch(/brew/);
    }
  });

  it("launchd label constant resolves to com.sethvoltz.friday", async () => {
    const { FRIDAY_LAUNCHD_LABEL } = await import("../lib/launchd.js");
    expect(FRIDAY_LAUNCHD_LABEL).toBe("com.sethvoltz.friday");
  });
});
