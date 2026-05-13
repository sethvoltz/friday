/**
 * FIX_FORWARD 6.4: containment-check tests for the workspace destroy flow.
 *
 * `assertInsideWorkspacesRoot` is the gate that protects every rm-equivalent
 * op from nuking files outside `~/.friday/workspaces/`. The realpath dance
 * matters because a malicious or accidental symlink inside a workspace
 * could otherwise resolve to system paths.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "friday-ws-test-"));
process.env.FRIDAY_DATA_DIR = root;

// Force fresh module load with the env var set above.
const { assertInsideWorkspacesRoot, workspacesRoot } = await import("./workspace.js");

beforeAll(() => {
  mkdirSync(workspacesRoot(), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("assertInsideWorkspacesRoot", () => {
  it("accepts a workspace inside the root", () => {
    const ws = join(workspacesRoot(), "builder-a");
    mkdirSync(ws, { recursive: true });
    expect(() => assertInsideWorkspacesRoot(ws)).not.toThrow();
  });

  it("rejects the workspaces root itself", () => {
    expect(() => assertInsideWorkspacesRoot(workspacesRoot())).toThrow(
      /root itself/,
    );
  });

  it("rejects an absolute path outside the workspaces root", () => {
    const outside = mkdtempSync(join(tmpdir(), "friday-ws-outside-"));
    try {
      expect(() => assertInsideWorkspacesRoot(outside)).toThrow(/outside/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a symlink that escapes the workspaces root", () => {
    const target = mkdtempSync(join(tmpdir(), "friday-ws-target-"));
    writeFileSync(join(target, "sentinel"), "");
    const link = join(workspacesRoot(), "evil-link");
    symlinkSync(target, link);
    try {
      expect(() => assertInsideWorkspacesRoot(link)).toThrow(/outside/);
    } finally {
      unlinkSync(link);
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("rejects a non-existent workspace when existsRequired is set", () => {
    const missing = join(workspacesRoot(), "never-created");
    expect(() => assertInsideWorkspacesRoot(missing)).toThrow(/not found/);
  });

  it("falls back to the normalized form when existsRequired is false", () => {
    const missing = join(workspacesRoot(), "tolerant-check");
    expect(() =>
      assertInsideWorkspacesRoot(missing, { existsRequired: false }),
    ).not.toThrow();
  });
});
