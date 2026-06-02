#!/usr/bin/env node
//
// packaging/pack.mjs — assemble the pre-baked, per-platform Friday tarball
// (FRI-146 / ADR-034, FRI-120 "variant 4b").
//
//   node packaging/pack.mjs [--out <dir>]
//
// Produces, under --out (default repo-root `dist-pack/`):
//   friday-<os>-<arch>.tar.gz          — the relocatable install tree
//   friday-<os>-<arch>.tar.gz.sha256   — `<digest>  <filename>` (shasum -a 256 form)
//   VERSION                            — the root package.json version, plain text
//
// The tarball is the EXACT tree that lands at
// `~/.local/share/friday/versions/<version>/` on a user's machine. It carries:
//   * build outputs (per-package `dist/`, dashboard `build/` + server-entry*.mjs)
//   * every workspace `package.json` (so the workspace shape findRepoRoot walks)
//   * the lockfile + workspace manifest + `.node-version` (fnm reads it on-device)
//   * `packages/shared/drizzle/` (migrate.js resolves it at `../../drizzle`)
//   * `bin/` + `LICENSE`
//   * the WHOLE prod `node_modules` tree (the "4b bundle") — root + `.pnpm`
//     store + per-workspace `node_modules` — so there is NO on-device
//     `pnpm install`. The caller runs `pnpm install --prod` under the pinned
//     Node BEFORE invoking this script (see release-publish.yml / ci.yml).
//
// Relocation correctness (the §3 hazard): pnpm bakes a pack-time absolute
// `NODE_PATH` into `.bin/*` command shims. We DELIBERATELY do not rewrite
// them and do NOT repack with `--node-linker=hoisted` — the supervisor spawns
// every child via `process.execPath` against the package's `cli.js` directly,
// never through a `.bin` shim, so the baked path is never read at runtime
// (supervisor.ts buildSpecs). We also do NOT bundle Node: fnm + `.node-version`
// provision the ABI-matched runtime on-device.
//
// Hard-errors before tarring if any required copy path is missing — a stale or
// partial build must fail the pack, not ship a broken artifact.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

// ---- args -------------------------------------------------------------

function parseArgs(argv) {
  let out = join(repoRoot, "dist-pack");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      const next = argv[i + 1];
      if (!next) {
        fail("--out requires a directory argument");
      }
      out = next;
      i++;
    }
  }
  return { out };
}

// ---- helpers ----------------------------------------------------------

function fail(msg) {
  process.stderr.write(`pack: ${msg}\n`);
  process.exit(1);
}

function log(msg) {
  process.stdout.write(`pack: ${msg}\n`);
}

/**
 * Platform tag for the artifact name. v1 builds darwin-arm64 only; the
 * naming (`friday-<os>-<arch>`) is shaped for a future Linux/x64 matrix row.
 */
function platformTag() {
  const osMap = { darwin: "darwin", linux: "linux" };
  const archMap = { arm64: "arm64", x64: "x64" };
  const os = osMap[process.platform];
  const arch = archMap[process.arch];
  if (!os || !arch) {
    fail(`unsupported platform ${process.platform}-${process.arch} (v1 builds darwin-arm64)`);
  }
  return `${os}-${arch}`;
}

/** Assert a repo-relative path exists; fail loudly if not. */
function requirePath(rel) {
  const abs = join(repoRoot, rel);
  if (!existsSync(abs)) {
    fail(`required path missing (run the build first): ${rel}`);
  }
  return abs;
}

/** Copy a repo-relative path into the same relative offset under stageDir. */
function stage(rel, stageDir, { required = true } = {}) {
  const src = join(repoRoot, rel);
  if (!existsSync(src)) {
    if (required) {
      fail(`required path missing (run the build first): ${rel}`);
    }
    return false;
  }
  const dest = join(stageDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  // dereference: false keeps pnpm's RELATIVE symlinks as symlinks so the
  // store/workspace link graph survives relocation byte-for-byte. (Absolute
  // symlinks would break; the §3 probe confirmed there are none.)
  cpSync(src, dest, { recursive: true, dereference: false });
  return true;
}

// ---- the copy manifest ------------------------------------------------

// Per-workspace build output (dist/ for packages + daemon; build/ for
// dashboard) and each workspace package.json. The workspace package.json set
// is exactly the 7 non-root manifests release-please bumps via extra-files,
// plus the root one.
const WORKSPACE_DIST = [
  "packages/cli/dist",
  "packages/shared/dist",
  "packages/memory/dist",
  "packages/evolve/dist",
  "packages/integrations/linear/dist",
  "services/daemon/dist",
  "services/dashboard/build",
];

const WORKSPACE_PKG_JSON = [
  "packages/cli/package.json",
  "packages/shared/package.json",
  "packages/memory/package.json",
  "packages/evolve/package.json",
  "packages/integrations/linear/package.json",
  "services/daemon/package.json",
  "services/dashboard/package.json",
];

// Root-level files the install tree needs.
const ROOT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".node-version",
  "LICENSE",
  "bin/friday",
  "bin/friday-supervisor",
];

// Dashboard production entrypoint + its proxy wrapper (server-entry.mjs imports
// ./build/handler.js and ./server-entry-proxy.mjs relative to itself).
const DASHBOARD_ENTRIES = [
  "services/dashboard/server-entry.mjs",
  "services/dashboard/server-entry-proxy.mjs",
];

// Drizzle migrations — migrate.js (at dist/db/) resolves them at ../../drizzle.
const DRIZZLE_DIR = "packages/shared/drizzle";

// The whole prod node_modules tree (the "4b bundle"): root + .pnpm store +
// per-workspace node_modules. The caller MUST have run `pnpm install --prod`
// first. We list each workspace's node_modules explicitly (rather than a single
// recursive root copy) because the per-workspace dirs are siblings of dist/ and
// hold the relative links back into the root .pnpm store.
const NODE_MODULES_DIRS = [
  "node_modules",
  "packages/cli/node_modules",
  "packages/shared/node_modules",
  "packages/memory/node_modules",
  "packages/evolve/node_modules",
  "packages/integrations/linear/node_modules",
  "services/daemon/node_modules",
  "services/dashboard/node_modules",
];

// ---- main -------------------------------------------------------------

function main() {
  const { out } = parseArgs(process.argv.slice(2));

  const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const version = rootPkg.version;
  if (!version) {
    fail("root package.json has no version");
  }
  const tag = platformTag();
  const artifactName = `friday-${tag}.tar.gz`;

  log(`version ${version}`);
  log(`platform ${tag}`);

  // Pre-flight: assert every required source path exists BEFORE we touch the
  // output dir, so a stale build fails fast and leaves no half-staged tree.
  for (const rel of [...WORKSPACE_DIST, ...WORKSPACE_PKG_JSON, ...ROOT_FILES, DRIZZLE_DIR]) {
    requirePath(rel);
  }
  for (const rel of DASHBOARD_ENTRIES) {
    requirePath(rel);
  }
  for (const rel of NODE_MODULES_DIRS) {
    requirePath(rel);
  }
  // The dashboard server-entry wrapper imports ./build/handler.js — verify the
  // built handler is actually present (catches a dashboard build that emitted
  // only client assets).
  requirePath("services/dashboard/build/handler.js");
  // prompts assets are copied into shared's dist/ at build time; the dispatch
  // prompt assembly reads them at runtime.
  requirePath("packages/shared/dist/prompts");

  // Fresh output dir.
  mkdirSync(out, { recursive: true });
  const stageDir = join(out, `friday-${version}-${tag}`);
  if (existsSync(stageDir)) {
    rmSync(stageDir, { recursive: true, force: true });
  }
  mkdirSync(stageDir, { recursive: true });

  log("staging build outputs");
  for (const rel of WORKSPACE_DIST) stage(rel, stageDir);
  for (const rel of WORKSPACE_PKG_JSON) stage(rel, stageDir);
  for (const rel of ROOT_FILES) stage(rel, stageDir);
  for (const rel of DASHBOARD_ENTRIES) stage(rel, stageDir);
  stage(DRIZZLE_DIR, stageDir);

  log("staging prod node_modules (4b bundle)");
  for (const rel of NODE_MODULES_DIRS) stage(rel, stageDir);

  // ---- tar --------------------------------------------------------------
  // Tar the staged tree at its own root so extraction yields the tree
  // directly (no leading `friday-<version>-<tag>/` component). `-C stageDir .`
  // packs the directory contents; macOS/BSD + GNU tar both honor this.
  const tarballPath = join(out, artifactName);
  log(`tarring → ${artifactName}`);
  const tarRes = spawnSync("tar", ["-czf", tarballPath, "-C", stageDir, "."], {
    stdio: "inherit",
  });
  if (tarRes.status !== 0) {
    fail(`tar exited ${tarRes.status}`);
  }
  if (!existsSync(tarballPath)) {
    fail(`tar produced no artifact at ${tarballPath}`);
  }

  // ---- sha256 -----------------------------------------------------------
  // `shasum -a 256` ships on stock macOS (/usr/bin/shasum); install.sh and the
  // publish workflow both verify with the same tool. Emit the canonical
  // `<digest>  <filename>` form so `shasum -c` works too. Compute the digest
  // over the tarball; install.sh's verify_sha256 reads the first whitespace
  // field, tolerating either bare-digest or two-field layouts.
  const shaRes = spawnSync("shasum", ["-a", "256", tarballPath], { encoding: "utf8" });
  if (shaRes.status !== 0 || !shaRes.stdout) {
    fail("shasum -a 256 failed");
  }
  const digest = shaRes.stdout.trim().split(/\s+/)[0];
  const shaPath = `${tarballPath}.sha256`;
  // Write the digest paired with the BARE artifact name (not the abs path) so
  // the published `.sha256` matches the released tarball's filename.
  writeFileSync(shaPath, `${digest}  ${artifactName}\n`);

  // ---- VERSION ----------------------------------------------------------
  const versionPath = join(out, "VERSION");
  writeFileSync(versionPath, `${version}\n`);

  const sizeMb = (statSync(tarballPath).size / (1024 * 1024)).toFixed(1);
  log(`artifact ${tarballPath} (${sizeMb} MB)`);
  log(`sha256   ${digest}`);
  log(`version  ${versionPath}`);

  // Emit machine-readable outputs for CI to consume without re-deriving.
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `tarball=${tarballPath}`,
        `sha256_file=${shaPath}`,
        `version_file=${versionPath}`,
        `artifact_name=${artifactName}`,
        `version=${version}`,
        `sha256=${digest}`,
        "",
      ].join("\n"),
      { flag: "a" },
    );
  }
}

main();
