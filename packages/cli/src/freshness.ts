import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Compute the newest mtime under `dir`, walking subdirectories. Returns 0
 * when the directory is missing — caller treats that as "no source", which
 * never blocks a build.
 */
function newestMtimeUnder(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      try {
        const m = statSync(path).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        // ignore
      }
    }
  }
  return newest;
}

export interface FreshnessCheck {
  /** `dist` (or `build`) artifact entry point that gets executed in prod. */
  artifactPath: string;
  /** Source directory whose newest mtime is compared against `artifactPath`. */
  srcDir: string;
  /** Build command to suggest to the user/agent on failure. */
  buildCommand: string;
}

/**
 * Throw if the prod artifact is missing or older than any source file. The
 * thrown error message is agent-parseable: it begins with `friday: build
 * required:` followed by the exact command to run. Status quo today is to
 * just spawn whatever's in `dist/` even if it's stale; we want a clean
 * error instead so silent stale-prod runs become impossible.
 */
export function assertArtifactFresh(check: FreshnessCheck): void {
  if (!existsSync(check.artifactPath)) {
    throw new Error(
      `friday: build required: ${check.buildCommand}\n` +
      `Missing artifact: ${check.artifactPath}`
    );
  }
  const artifactMtime = statSync(check.artifactPath).mtimeMs;
  const srcMtime = newestMtimeUnder(check.srcDir);
  if (srcMtime > artifactMtime) {
    throw new Error(
      `friday: build required: ${check.buildCommand}\n` +
      `Artifact ${check.artifactPath} is older than source under ${check.srcDir}`
    );
  }
}
