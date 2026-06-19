/**
 * Tests for the per-worker test-data-dir lifecycle (FRI-170).
 *
 * Sweep tests run against an injected `root` + `now` so they are fully
 * deterministic and never touch the real `os.tmpdir()`; mtimes are pinned with
 * `utimesSync` to whole-second values to dodge filesystem mtime granularity.
 * Manifest tests pass the manifest dir EXPLICITLY to `createManagedDataDir` so
 * they never mutate the shared `MANIFEST_ENV` the running worker relies on
 * (mutating it intermittently mis-routed other workers' markers).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MANIFEST_ENV,
  TEST_DATA_DIR_PREFIX,
  createDataDirManifest,
  createManagedDataDir,
  decideDataDir,
  initDataDirManifest,
  readManifestDataDirs,
  reclaimManifestDataDirs,
  removeDataDirsBestEffort,
  sweepStaleDataDirs,
} from "./tmp-data-dir.js";

// Pin an mtime (seconds granularity) on a path.
function setMtime(path: string, epochSeconds: number): void {
  utimesSync(path, new Date(epochSeconds * 1000), new Date(epochSeconds * 1000));
}

// Track on-disk paths these tests create under the real tmpdir so they are
// always cleaned up (they are recorded only in throwaway manifests, so the
// run's own globalSetup teardown will not reclaim them).
const litter: string[] = [];
afterEach(() => {
  for (const p of litter) rmSync(p, { recursive: true, force: true });
  litter.length = 0;
});

describe("decideDataDir (AC2 — caller dirs are adopted, never managed)", () => {
  const realDir = resolve(join(homedir(), ".friday"));

  it("unset env → create (setup must mkdtemp a managed dir)", () => {
    expect(decideDataDir(undefined, realDir)).toEqual({ kind: "create" });
  });

  it("caller-provided tmp dir → adopt (used as-is, never recorded/deleted)", () => {
    const caller = "/tmp/some-caller-chosen-dir";
    expect(decideDataDir(caller, realDir)).toEqual({ kind: "adopt", dir: resolve(caller) });
  });

  it("a relative caller dir is resolved to absolute and adopted", () => {
    const d = decideDataDir("./rel/data", realDir);
    expect(d.kind).toBe("adopt");
    expect(d).toMatchObject({ dir: resolve("./rel/data") });
  });

  it("env pointing at the real ~/.friday/ → reject (setup must throw)", () => {
    expect(decideDataDir(realDir, realDir)).toEqual({ kind: "reject", realDir });
  });

  it("a non-normalized path to the real dir still rejects", () => {
    const messy = join(realDir, "..", ".friday");
    expect(decideDataDir(messy, realDir)).toEqual({ kind: "reject", realDir });
  });
});

describe("sweepStaleDataDirs", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function mkDir(name: string, epochSeconds: number): string {
    const p = join(root, name);
    mkdirSync(p);
    setMtime(p, epochSeconds);
    return p;
  }

  it("removes only prefixed dirs older than ageMs; spares fresh + foreign", () => {
    root = mkdtempSync(join(tmpdir(), "fri170-sweep-root-"));
    const NOW = 1_000_000; // seconds-friendly ms value
    const stale = mkDir(`${TEST_DATA_DIR_PREFIX}stale`, 1); // mtimeMs=1000, very old
    const fresh = mkDir(`${TEST_DATA_DIR_PREFIX}fresh`, NOW / 1000); // mtimeMs=NOW
    const foreign = mkDir("some-other-tmp-dir", 1); // old but not our prefix

    const removed = sweepStaleDataDirs({ root, now: NOW, ageMs: 100_000 });

    expect(removed).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // too fresh — spared
    expect(existsSync(foreign)).toBe(true); // wrong prefix — spared
  });

  it("treats the age threshold as inclusive (now - mtime === ageMs is swept)", () => {
    root = mkdtempSync(join(tmpdir(), "fri170-sweep-root-"));
    const NOW = 1_000_000;
    const atThreshold = mkDir(`${TEST_DATA_DIR_PREFIX}at`, (NOW - 100_000) / 1000); // exactly ageMs old
    const justUnder = mkDir(`${TEST_DATA_DIR_PREFIX}under`, (NOW - 99_000) / 1000); // ageMs-1 old

    const removed = sweepStaleDataDirs({ root, now: NOW, ageMs: 100_000 });

    expect(removed).toEqual([atThreshold]);
    expect(existsSync(atThreshold)).toBe(false);
    expect(existsSync(justUnder)).toBe(true);
  });

  it("never sweeps a protected dir even if old + prefixed (AC2: adopted caller dir)", () => {
    root = mkdtempSync(join(tmpdir(), "fri170-sweep-root-"));
    const NOW = 1_000_000;
    const protectedDir = mkDir(`${TEST_DATA_DIR_PREFIX}adopted`, 1); // old + prefixed
    const other = mkDir(`${TEST_DATA_DIR_PREFIX}other`, 1); // old + prefixed

    const removed = sweepStaleDataDirs({ root, now: NOW, ageMs: 100_000, protect: [protectedDir] });

    expect(removed).toEqual([other]);
    expect(existsSync(protectedDir)).toBe(true); // protected — spared despite age
    expect(existsSync(other)).toBe(false);
  });

  it("ignores a prefixed *file* (only directories are swept)", () => {
    root = mkdtempSync(join(tmpdir(), "fri170-sweep-root-"));
    const filePath = join(root, `${TEST_DATA_DIR_PREFIX}not-a-dir`);
    writeFileSync(filePath, "x");
    setMtime(filePath, 1); // old

    const removed = sweepStaleDataDirs({ root, now: 1_000_000, ageMs: 1 });

    expect(removed).toEqual([]);
    expect(existsSync(filePath)).toBe(true);
  });

  it("returns [] and does not throw when the root does not exist", () => {
    const missing = join(tmpdir(), "fri170-definitely-missing-root-xyz");
    expect(sweepStaleDataDirs({ root: missing, now: 1_000_000, ageMs: 1 })).toEqual([]);
  });
});

describe("manifest lifecycle (createManagedDataDir → reclaim)", () => {
  it("createDataDirManifest returns a prefixed manifest dir with no env side effect", () => {
    const before = process.env[MANIFEST_ENV];
    const manifest = createDataDirManifest();
    litter.push(manifest);
    expect(existsSync(manifest)).toBe(true);
    expect(manifest.startsWith(join(tmpdir(), `${TEST_DATA_DIR_PREFIX}manifest-`))).toBe(true);
    expect(process.env[MANIFEST_ENV]).toBe(before); // unchanged
  });

  it("initDataDirManifest publishes the manifest path via MANIFEST_ENV", () => {
    const orig = process.env[MANIFEST_ENV];
    try {
      const manifest = initDataDirManifest();
      litter.push(manifest);
      expect(process.env[MANIFEST_ENV]).toBe(manifest);
    } finally {
      if (orig === undefined) delete process.env[MANIFEST_ENV];
      else process.env[MANIFEST_ENV] = orig;
    }
  });

  it("createManagedDataDir creates a prefixed dir and records it in the given manifest", () => {
    const manifest = createDataDirManifest();
    litter.push(manifest);
    const dir = createManagedDataDir(manifest);
    litter.push(dir);

    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(join(tmpdir(), TEST_DATA_DIR_PREFIX))).toBe(true);
    expect(readManifestDataDirs(manifest)).toEqual([dir]);
  });

  it("reclaimManifestDataDirs removes EVERY recorded dir (incl. a would-be-skipped file's) and the manifest dir", () => {
    const manifest = createDataDirManifest();
    // Two workers' dirs; the second models a fully-skipped file whose per-file
    // afterAll would never fire — the manifest still captured it at create time.
    const d1 = createManagedDataDir(manifest);
    const d2 = createManagedDataDir(manifest);
    expect(existsSync(d1)).toBe(true);
    expect(existsSync(d2)).toBe(true);

    const reclaimed = reclaimManifestDataDirs(manifest);

    // Order follows readdir, not insertion — compare as sets.
    expect([...reclaimed].sort()).toEqual([d1, d2].sort());
    expect(existsSync(d1)).toBe(false);
    expect(existsSync(d2)).toBe(false);
    expect(existsSync(manifest)).toBe(false); // manifest dir removed too
  });

  it("readManifestDataDirs reads marker contents (trimmed); missing manifest dir → []", () => {
    const manifest = createDataDirManifest();
    litter.push(manifest);
    writeFileSync(join(manifest, "marker-a"), "/a/b");
    writeFileSync(join(manifest, "marker-b"), "  /c/d  \n");
    expect(readManifestDataDirs(manifest).sort()).toEqual(["/a/b", "/c/d"]);
    expect(readManifestDataDirs(join(tmpdir(), "fri170-no-such-manifest"))).toEqual([]);
  });

  it("createManagedDataDir with no manifest still creates a dir (no throw, not recorded)", () => {
    const dir = createManagedDataDir(undefined);
    litter.push(dir);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("AC2 end-to-end — an adopted caller dir survives the full cleanup cycle", () => {
  it("a caller-provided dir is never recorded nor removed by reclaim", () => {
    // A real caller dir with a sentinel inside it.
    const caller = mkdtempSync(join(tmpdir(), "friday-caller-owned-"));
    litter.push(caller);
    const sentinel = join(caller, "precious.txt");
    writeFileSync(sentinel, "do not delete");

    const realDir = resolve(join(homedir(), ".friday"));
    // The setup wiring: a caller-provided FRIDAY_DATA_DIR is `adopt` and is NOT
    // passed through createManagedDataDir, so it never enters the manifest.
    expect(decideDataDir(caller, realDir)).toEqual({ kind: "adopt", dir: caller });

    const manifest = createDataDirManifest();
    const managed = createManagedDataDir(manifest); // a real managed dir IS recorded
    expect(readManifestDataDirs(manifest)).toEqual([managed]);
    expect(readManifestDataDirs(manifest)).not.toContain(caller);

    reclaimManifestDataDirs(manifest);

    expect(existsSync(managed)).toBe(false); // managed dir reclaimed
    expect(existsSync(caller)).toBe(true); // caller dir untouched
    expect(existsSync(sentinel)).toBe(true); // its contents intact
  });
});

describe("removeDataDirsBestEffort", () => {
  it("removes existing dirs and ignores missing ones without throwing", () => {
    const present = mkdtempSync(join(tmpdir(), "fri170-rm-present-"));
    const missing = join(tmpdir(), "fri170-rm-missing-xyz");

    expect(() => removeDataDirsBestEffort([present, missing])).not.toThrow();
    expect(existsSync(present)).toBe(false);
  });
});
