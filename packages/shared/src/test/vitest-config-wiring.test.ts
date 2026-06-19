/**
 * Static wiring guard (FRI-170). The per-worker data-dir reclaim guarantee
 * lives in `global-setup.ts`, invoked via each vitest config's `globalSetup`.
 * If a config wires the shared `vitest-setup.ts` (which CREATES per-worker data
 * dirs) but forgets `global-setup.ts` (which REMOVES them), that package's runs
 * would leak dirs again. This test fails fast on that mismatch so the
 * regression is caught at the config layer rather than discovered as disk rot.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Recursively find vitest config files under a dir, skipping node_modules/dist. */
function findVitestConfigs(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) findVitestConfigs(full, acc);
    else if (/^vitest(\.e2e)?\.config\.ts$/.test(name)) acc.push(full);
  }
  return acc;
}

describe("vitest config wiring (FRI-170)", () => {
  const configs = [
    ...findVitestConfigs(join(repoRoot, "packages")),
    ...findVitestConfigs(join(repoRoot, "services")),
  ];

  it("global-setup.ts exists where the configs reference it", () => {
    expect(existsSync(join(repoRoot, "packages/shared/src/test/global-setup.ts"))).toBe(true);
  });

  it("discovers the known vitest configs (walk is not vacuously empty)", () => {
    // 6 unit configs + 2 e2e configs at time of writing; guard against the walk
    // silently finding nothing and passing the per-config check vacuously.
    expect(configs.length).toBeGreaterThanOrEqual(6);
  });

  it("every config that wires the shared vitest-setup also wires global-setup", () => {
    const offenders: string[] = [];
    for (const cfg of configs) {
      const src = readFileSync(cfg, "utf8");
      if (src.includes("vitest-setup") && !src.includes("global-setup")) {
        offenders.push(cfg.slice(repoRoot.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
