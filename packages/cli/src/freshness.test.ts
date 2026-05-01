import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertArtifactFresh } from "./freshness.js";

const root = join(tmpdir(), `friday-fresh-${process.pid}-${Date.now()}`);
const distDir = join(root, "dist");
const srcDir = join(root, "src");
const artifact = join(distDir, "index.js");

function setMtime(path: string, secondsAgo: number): void {
  const t = (Date.now() - secondsAgo * 1000) / 1000;
  utimesSync(path, t, t);
}

describe("assertArtifactFresh", () => {
  beforeEach(() => {
    mkdirSync(distDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes when artifact is newer than all source", () => {
    writeFileSync(join(srcDir, "a.ts"), "src");
    setMtime(join(srcDir, "a.ts"), 60);
    writeFileSync(artifact, "built");
    setMtime(artifact, 1);

    expect(() =>
      assertArtifactFresh({
        artifactPath: artifact,
        srcDir,
        buildCommand: "pnpm build",
      })
    ).not.toThrow();
  });

  it("throws agent-parseable error when artifact is missing", () => {
    expect(() =>
      assertArtifactFresh({
        artifactPath: artifact,
        srcDir,
        buildCommand: "pnpm --filter @friday/daemon build",
      })
    ).toThrow(/friday: build required: pnpm --filter @friday\/daemon build/);
  });

  it("throws when source is newer than artifact", () => {
    writeFileSync(artifact, "built");
    setMtime(artifact, 60);
    writeFileSync(join(srcDir, "a.ts"), "src");
    setMtime(join(srcDir, "a.ts"), 1);

    expect(() =>
      assertArtifactFresh({
        artifactPath: artifact,
        srcDir,
        buildCommand: "pnpm build",
      })
    ).toThrow(/friday: build required:/);
  });

  it("ignores node_modules and dot-prefixed dirs", () => {
    writeFileSync(artifact, "built");
    setMtime(artifact, 60);
    mkdirSync(join(srcDir, "node_modules"), { recursive: true });
    writeFileSync(join(srcDir, "node_modules", "junk.ts"), "junk");
    setMtime(join(srcDir, "node_modules", "junk.ts"), 1);
    mkdirSync(join(srcDir, ".turbo"), { recursive: true });
    writeFileSync(join(srcDir, ".turbo", "junk.ts"), "junk");
    setMtime(join(srcDir, ".turbo", "junk.ts"), 1);

    expect(() =>
      assertArtifactFresh({ artifactPath: artifact, srcDir, buildCommand: "pnpm build" })
    ).not.toThrow();
  });
});
