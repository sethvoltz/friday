/**
 * Unit tests for the FRI-61 cwd-pin migration. Exercises the rename
 * mechanics + EXDEV fallback against a per-test sandbox of
 * `~/.claude/projects/` and an in-memory list of "agent rows."
 *
 * We don't spin up a real DB here; `migrateOneAgent` (the unit under
 * test) takes the agent identity + target cwd as arguments and never
 * touches Postgres. End-to-end coverage of the full `agentCwdPinV1.run()`
 * pipeline against the registry happens in the e2e suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  encodeProjectDir,
  sessionFilePath,
  sessionSidecarDir,
} from "../agent/jsonl-paths.js";

const projectsDir = join(homedir(), ".claude", "projects");

function hexId(): string {
  return randomBytes(8).toString("hex");
}

interface Fixture {
  oldCwd: string;
  newCwd: string;
  sessionId: string;
  oldJsonl: string;
  newJsonl: string;
  oldSidecar: string;
  newSidecar: string;
  body: string;
}

function setupFixture(opts?: { withSidecar?: boolean }): Fixture {
  const sessionId = hexId();
  const oldCwd = `/tmp/fri61-old-${hexId()}`;
  const newCwd = `/tmp/fri61-new-${hexId()}`;
  const oldEncoded = join(projectsDir, encodeProjectDir(oldCwd));
  mkdirSync(oldEncoded, { recursive: true });
  const body = `{"event":"session-start","sessionId":"${sessionId}"}\n`;
  const oldJsonl = join(oldEncoded, `${sessionId}.jsonl`);
  writeFileSync(oldJsonl, body);
  const oldSidecar = join(oldEncoded, sessionId);
  if (opts?.withSidecar) {
    mkdirSync(join(oldSidecar, "tool-results"), { recursive: true });
    writeFileSync(
      join(oldSidecar, "tool-results", "tool-x-1.txt"),
      "sidecar payload",
    );
  }
  return {
    oldCwd,
    newCwd,
    sessionId,
    oldJsonl,
    newJsonl: sessionFilePath(newCwd, sessionId),
    oldSidecar,
    newSidecar: sessionSidecarDir(newCwd, sessionId),
    body,
  };
}

function checksum(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agentCwdPinV1.migrateOneAgent", () => {
  const cleanups: string[] = [];

  beforeEach(() => {
    cleanups.length = 0;
  });

  afterEach(() => {
    for (const dir of cleanups) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves the JSONL into the new encoded-cwd dir (happy path)", async () => {
    const fx = setupFixture();
    cleanups.push(join(projectsDir, encodeProjectDir(fx.oldCwd)));
    cleanups.push(join(projectsDir, encodeProjectDir(fx.newCwd)));
    const checksumBefore = checksum(fx.oldJsonl);

    const { migrateOneAgent } = await import("./agent-cwd-pin-v1.js");
    const errors: Array<{ agent: string; session: string; message: string }> =
      [];
    const outcome = await migrateOneAgent(
      "test-agent",
      fx.sessionId,
      fx.newCwd,
      errors,
    );

    expect(errors).toEqual([]);
    expect(outcome.moved).toBe(true);
    expect(outcome.sidecarMoved).toBe(false);
    expect(existsSync(fx.newJsonl)).toBe(true);
    expect(existsSync(fx.oldJsonl)).toBe(false);
    expect(checksum(fx.newJsonl)).toBe(checksumBefore);
  });

  it("moves the sidecar dir when present", async () => {
    const fx = setupFixture({ withSidecar: true });
    cleanups.push(join(projectsDir, encodeProjectDir(fx.oldCwd)));
    cleanups.push(join(projectsDir, encodeProjectDir(fx.newCwd)));

    const { migrateOneAgent } = await import("./agent-cwd-pin-v1.js");
    const errors: Array<{ agent: string; session: string; message: string }> =
      [];
    const outcome = await migrateOneAgent(
      "test-agent",
      fx.sessionId,
      fx.newCwd,
      errors,
    );

    expect(outcome.moved).toBe(true);
    expect(outcome.sidecarMoved).toBe(true);
    expect(existsSync(fx.newSidecar)).toBe(true);
    expect(existsSync(fx.oldSidecar)).toBe(false);
    expect(
      readFileSync(
        join(fx.newSidecar, "tool-results", "tool-x-1.txt"),
        "utf8",
      ),
    ).toBe("sidecar payload");
  });

  it("falls back to copy+unlink on EXDEV (file)", async () => {
    const fx = setupFixture();
    cleanups.push(join(projectsDir, encodeProjectDir(fx.oldCwd)));
    cleanups.push(join(projectsDir, encodeProjectDir(fx.newCwd)));
    const checksumBefore = checksum(fx.oldJsonl);

    const { renameWithExdevFallback } = await import("./agent-cwd-pin-v1.js");
    const throwingRename = vi.fn((_a: string, _b: string) => {
      const e: NodeJS.ErrnoException = Object.assign(
        new Error("EXDEV cross-device link"),
        { code: "EXDEV" },
      );
      throw e;
    });

    // Production code in `migrateOneAgent` creates the dest parent dir
    // before calling renameWithExdevFallback; the helper itself doesn't.
    mkdirSync(join(projectsDir, encodeProjectDir(fx.newCwd)), {
      recursive: true,
    });

    renameWithExdevFallback(fx.oldJsonl, fx.newJsonl, throwingRename);

    expect(throwingRename).toHaveBeenCalledOnce();
    expect(existsSync(fx.newJsonl)).toBe(true);
    expect(existsSync(fx.oldJsonl)).toBe(false);
    expect(checksum(fx.newJsonl)).toBe(checksumBefore);
  });

  it("falls back to cpSync+rmSync on EXDEV (directory)", async () => {
    const fx = setupFixture({ withSidecar: true });
    cleanups.push(join(projectsDir, encodeProjectDir(fx.oldCwd)));
    cleanups.push(join(projectsDir, encodeProjectDir(fx.newCwd)));

    const { renameWithExdevFallback } = await import("./agent-cwd-pin-v1.js");
    const throwingRename = vi.fn((_a: string, _b: string) => {
      const e: NodeJS.ErrnoException = Object.assign(
        new Error("EXDEV cross-device link"),
        { code: "EXDEV" },
      );
      throw e;
    });

    // Need the dest dir parent to exist for cpSync recursive.
    mkdirSync(join(projectsDir, encodeProjectDir(fx.newCwd)), {
      recursive: true,
    });
    renameWithExdevFallback(fx.oldSidecar, fx.newSidecar, throwingRename);

    expect(throwingRename).toHaveBeenCalledOnce();
    expect(existsSync(fx.newSidecar)).toBe(true);
    expect(existsSync(fx.oldSidecar)).toBe(false);
    expect(
      readFileSync(
        join(fx.newSidecar, "tool-results", "tool-x-1.txt"),
        "utf8",
      ),
    ).toBe("sidecar payload");
  });

  it("is idempotent — second run is a no-op if destination already exists", async () => {
    const fx = setupFixture();
    cleanups.push(join(projectsDir, encodeProjectDir(fx.oldCwd)));
    cleanups.push(join(projectsDir, encodeProjectDir(fx.newCwd)));

    const { migrateOneAgent } = await import("./agent-cwd-pin-v1.js");
    const errors: Array<{ agent: string; session: string; message: string }> =
      [];
    await migrateOneAgent("test-agent", fx.sessionId, fx.newCwd, errors);
    // Recreate the source so the test can prove the second call skips
    // rather than overwriting.
    mkdirSync(join(projectsDir, encodeProjectDir(fx.oldCwd)), {
      recursive: true,
    });
    writeFileSync(fx.oldJsonl, "DIFFERENT CONTENT — should not move");

    const outcome = await migrateOneAgent(
      "test-agent",
      fx.sessionId,
      fx.newCwd,
      errors,
    );

    expect(outcome.moved).toBe(false);
    expect(existsSync(fx.newJsonl)).toBe(true);
    expect(readFileSync(fx.newJsonl, "utf8")).toBe(fx.body); // original body
    expect(existsSync(fx.oldJsonl)).toBe(true); // source untouched
    expect(readFileSync(fx.oldJsonl, "utf8")).toBe(
      "DIFFERENT CONTENT — should not move",
    );
  });

  it("returns moved:false silently when no source can be found", async () => {
    const newCwd = `/tmp/fri61-empty-${hexId()}`;
    cleanups.push(join(projectsDir, encodeProjectDir(newCwd)));

    const { migrateOneAgent } = await import("./agent-cwd-pin-v1.js");
    const errors: Array<{ agent: string; session: string; message: string }> =
      [];
    const outcome = await migrateOneAgent(
      "test-agent",
      "no-such-session",
      newCwd,
      errors,
    );

    expect(outcome.moved).toBe(false);
    expect(errors).toEqual([]);
  });
});
