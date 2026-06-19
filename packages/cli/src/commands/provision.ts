/**
 * `friday provision` — install/repair Friday's runtime dependencies.
 *
 * The single, operator-interactive ACTUATOR for everything `checkDeps` only
 * DETECTS: it `brew install`s any missing Brewfile dep (pgvector first), then
 * creates the pgvector `vector` extension via the admin/superuser connection
 * (the `friday` role can't), then warms the embedding model (fail-open).
 *
 * Two callers run this, and ONLY these — installs never happen on the launchd
 * boot path:
 *   1. The operator, by hand, when the boot gate (`friday start` / the
 *      supervisor preflight) reports a missing hard dep and tells them to run
 *      `friday provision`.
 *   2. `friday update`, which execs `current/bin/friday provision` (the NEW
 *      version's binary) AFTER flipping `current`. Because it's the new binary,
 *      it carries whatever deps that release introduced — which is exactly the
 *      self-reference the old in-process provisioning couldn't escape (the
 *      outgoing version can't know about a dep added in the version it's
 *      installing).
 *
 * Idempotent: a fully-provisioned box prints all ⏭/✓ and exits 0. A HARD
 * failure (pgvector binary or extension) exits non-zero with remedies so the
 * update aborts before restarting the daemon into a missing-`vector` migration.
 */

import { defineCommand } from "citty";
import pc from "picocolors";
import { ensureVectorExtension } from "@friday/shared";
import { ensureBrewDeps } from "../lib/brew-deps.js";
import {
  ensureEmbeddingAssets,
  type EnsureEmbeddingAssetsResult,
} from "../lib/embedding-assets.js";
import { currentLink } from "../lib/install-paths.js";

/** Injectable side-effect surface so the unit suite drives every branch
 *  without shelling out to brew / Postgres / the model download. */
export interface ProvisionDeps {
  ensureBrewDeps(): { installed: string[]; alreadyPresent: string[]; failed: string[] };
  ensureVectorExtension(): Promise<boolean>;
  ensureEmbeddingAssets(installDir: string): Promise<EnsureEmbeddingAssetsResult>;
  installDir(): string;
  log(line: string): void;
}

export const defaultProvisionDeps: ProvisionDeps = {
  ensureBrewDeps: () => ensureBrewDeps(),
  ensureVectorExtension: () => ensureVectorExtension(),
  ensureEmbeddingAssets: (installDir) => ensureEmbeddingAssets({ installDir }),
  installDir: () => currentLink(),
  log: (line) => console.log(line),
};

export interface ProvisionResult {
  ok: boolean;
  /** Human-readable causes of a HARD failure (empty when ok). */
  failures: string[];
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the provisioning steps in their load-bearing order. HARD steps (brew
 * deps, the `vector` extension) accumulate into `failures` and flip `ok` false;
 * the embedding warm is SOFT (fail-open) and never affects `ok`.
 */
export async function runProvision(deps: ProvisionDeps): Promise<ProvisionResult> {
  const failures: string[] = [];

  // 1. brew deps (HARD: pgvector supplies the `vector` type for migration 0036).
  deps.log("Installing Homebrew dependencies…");
  let brew: { installed: string[]; alreadyPresent: string[]; failed: string[] };
  try {
    brew = deps.ensureBrewDeps();
  } catch (err) {
    deps.log(pc.yellow(`  ✗ brew install failed: ${msg(err)}`));
    return { ok: false, failures: [`brew: ${msg(err)}`] };
  }
  if (brew.installed.length) deps.log(pc.green(`  ✓ installed ${brew.installed.join(", ")}`));
  if (brew.alreadyPresent.length)
    deps.log(pc.dim(`  ⏭ already present: ${brew.alreadyPresent.join(", ")}`));
  if (brew.failed.length) {
    // Only pgvector is BOOT-CRITICAL: its absence crash-loops the daemon at
    // migration 0036. The other Brewfile deps (fnm/pnpm/cloudflared/gh) are
    // either supervisor prerequisites or build/tunnel-only — and they're often
    // installed by a NON-brew method (pnpm via corepack, node via fnm), so
    // `brew list` reports them absent and `brew install` may fail even on a
    // perfectly healthy box. Failing the whole provision (→ rolling back a
    // `friday update`) on one of those would be wrong, so only pgvector failing
    // is fatal; the rest are a non-fatal warning.
    const pgvectorFailed = brew.failed.includes("pgvector");
    const otherFailed = brew.failed.filter((d) => d !== "pgvector");
    if (otherFailed.length) {
      deps.log(
        pc.dim(
          `  · ${otherFailed.join(", ")} not installed via brew (non-critical — install manually if you need them)`,
        ),
      );
    }
    if (pgvectorFailed) {
      failures.push("brew install failed: pgvector");
      deps.log(pc.yellow("  ✗ pgvector install failed — install it manually"));
    }
  }

  // 2. pgvector EXTENSION (HARD). Skip when the binary install failed — the
  // CREATE would just throw "could not open extension control file".
  if (brew.failed.includes("pgvector")) {
    deps.log(pc.yellow("  ✗ skipping pgvector extension — the pgvector binary isn't installed"));
  } else {
    deps.log("Enabling pgvector extension…");
    try {
      const created = await deps.ensureVectorExtension();
      deps.log(
        created
          ? pc.green("  ✓ pgvector extension enabled")
          : pc.dim("  ⏭ pgvector extension already enabled"),
      );
    } catch (err) {
      failures.push(`pgvector extension: ${msg(err)}`);
      deps.log(pc.yellow(`  ✗ pgvector extension could not be enabled: ${msg(err)}`));
    }
  }

  // 3. Embedding model warm (SOFT / fail-open — recall degrades to FTS-only).
  deps.log("Warming embedding model…");
  const assets = await deps.ensureEmbeddingAssets(deps.installDir());
  if (assets.status === "warmed") {
    deps.log(pc.green("  ✓ embedding model ready"));
  } else {
    const why = assets.status === "error" ? ` (${assets.error})` : "";
    deps.log(pc.dim(`  · embedding model unavailable — recall falls back to FTS-only${why}`));
  }

  return { ok: failures.length === 0, failures };
}

export const provisionCommand = defineCommand({
  meta: {
    name: "provision",
    description:
      "Install/repair Friday's runtime deps (pgvector + extension, embedding model). Idempotent.",
  },
  async run() {
    const result = await runProvision(defaultProvisionDeps);
    if (!result.ok) {
      console.error(pc.red("\nprovisioning incomplete:"));
      for (const f of result.failures) console.error(`  · ${f}`);
      console.error(
        pc.dim("\nresolve the above, then re-run ") +
          pc.cyan("friday provision") +
          pc.dim(" and ") +
          pc.cyan("friday restart") +
          pc.dim("."),
      );
      process.exit(1);
    }
    console.log(
      pc.green("\n✔ dependencies provisioned. ") +
        pc.dim("If the stack was blocked, it self-heals within ~15s — or run ") +
        pc.cyan("friday restart") +
        pc.dim("."),
    );
  },
});
