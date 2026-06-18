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
// Symlink relativization (the v1.1.0 distribution bug): on a local dev box,
// pnpm produces RELATIVE per-package symlinks (e.g. `services/dashboard/
// node_modules/shiki -> ../../../node_modules/.pnpm/shiki@1.29.2/.../shiki`).
// On GitHub Actions runners, the same install produces ABSOLUTE symlinks
// (`-> /Users/runner/work/friday/friday/node_modules/.pnpm/...`) — likely a
// cross-filesystem fallback in pnpm. cpSync(dereference:false) preserves
// whatever shape pnpm wrote, so the absolute targets survived into the
// published v1.1.0 tarball and pointed at a runner path that doesn't exist on
// any user machine → `Cannot find package 'citty'` on every install. We post-
// process the staged tree: every symlink whose target is absolute and points
// inside `repoRoot` is rewritten to a path relative to its own parent dir, so
// the entire link graph survives byte-for-byte relocation. Symlinks already
// relative are left alone; any absolute symlink pointing OUTSIDE repoRoot
// fails the pack (an escape would mean a missing target on the user box).
//
// Hard-errors before tarring if any required copy path is missing — a stale or
// partial build must fail the pack, not ship a broken artifact.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

// ---- onnxruntime-node strip (FRI-24) ----------------------------------
//
// onnxruntime-node bundles ~210MB of all-platform CPU binaries under its
// `bin/napi-v6/<platform>/<arch>/` tree, PER store copy. Friday does NOT use
// the native onnxruntime-node backend at all — inference runs on
// onnxruntime-web's WASM backend (see packages/memory/src/embed-runtime.ts),
// whose small `.wasm` files ship inside the SEPARATE `onnxruntime-web` package
// and stay in the tarball. onnxruntime-node is only present because
// @huggingface/transformers@4.2.0 statically imports it for its (pure-JS)
// AutoTokenizer; a pnpm patch (patches/onnxruntime-node@1.24.3.patch) makes that
// import no-op when the native binary is absent. So the native `bin/` tree is
// DEAD WEIGHT on every platform — we DELIBERATELY drop it (keeping the package's
// JS so the import still resolves). There is nothing to re-fetch on-device:
// missing native binary is irrelevant because the WASM backend does the work.
//
// We strip the `bin/` of EVERY onnxruntime-node store copy. The pnpm patch
// causes pnpm to materialize the package twice — the bare
// `onnxruntime-node@<v>` dir AND a `onnxruntime-node@<v>_patch_hash=<hash>` dir
// (the one transformers actually resolves to) — and BOTH carry the 210MB bin/
// tree. A glob over `onnxruntime-node@*` strips both and is robust to the hash
// changing when the patch is edited. The CLI's `lib/embedding-assets.ts` no
// longer re-fetches anything (WASM needs no native binary), so there is no
// version/path constant to keep in sync here anymore.
const ORT_PKG_GLOB_PREFIX = "onnxruntime-node@";
const ORT_BIN_SUBDIR = "bin";

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
 * Platform tag for the artifact name. Tags the tarball from the runner's own
 * process.platform/arch — darwin-arm64 (Apple Silicon, primary) and darwin-x64
 * (Intel, legacy) are built today, each on a runner of that arch; the naming
 * (`friday-<os>-<arch>`) is also shaped for a future Linux row.
 */
function platformTag() {
  const osMap = { darwin: "darwin", linux: "linux" };
  const archMap = { arm64: "arm64", x64: "x64" };
  const os = osMap[process.platform];
  const arch = archMap[process.arch];
  if (!os || !arch) {
    fail(
      `unsupported platform ${process.platform}-${process.arch} (Friday builds darwin-arm64 / darwin-x64)`,
    );
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

/**
 * Walk every symlink under `stageDir`. For each one whose target is absolute
 * and starts with `srcRoot + "/"`, rewrite it to a relative path from the
 * symlink's parent dir to the equivalent location inside `stageDir`. Symlinks
 * with relative targets are left as-is (they're already correct under the
 * relocation). Absolute symlinks pointing OUTSIDE srcRoot are fatal — they
 * would dangle on the user's box and indicate a bundling mistake.
 *
 * Returns `{ rewrote, kept }` counts for the pack log.
 */
function relativizeSymlinks(stageDir, srcRoot) {
  const srcPrefix = srcRoot.endsWith("/") ? srcRoot : `${srcRoot}/`;
  let rewrote = 0;
  let kept = 0;

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(full);
        if (target.startsWith("/")) {
          if (target.startsWith(srcPrefix)) {
            // Strip the srcRoot prefix to get the path relative to the pack
            // source — that same path inside stageDir is the new target.
            const subpath = target.slice(srcPrefix.length);
            const newAbsTarget = join(stageDir, subpath);
            const newRelTarget = relative(dirname(full), newAbsTarget);
            unlinkSync(full);
            symlinkSync(newRelTarget, full);
            rewrote++;
          } else {
            fail(
              `absolute symlink escapes pack source: ${full} -> ${target} ` +
                `(srcRoot=${srcRoot}). Refusing to ship a tarball with a ` +
                `target that won't exist on the user's machine.`,
            );
          }
        } else {
          kept++;
        }
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };

  walk(stageDir);
  return { rewrote, kept };
}

/**
 * Recursively sum the byte size of every regular file under `dir` (following
 * no symlinks). Used to log how much weight the onnxruntime strip removes.
 */
function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else if (entry.isFile()) {
      total += statSync(full).size;
    }
  }
  return total;
}

/**
 * Strip the onnxruntime-node native binary tree (`bin/`) out of EVERY staged
 * pnpm store copy (FRI-24). Keeps each package's JS (`dist/`, `lib/`,
 * package.json) so `require('onnxruntime-node')` (via transformers'
 * AutoTokenizer) still resolves — only the heavy
 * `bin/napi-v6/<platform>/<arch>/` native blobs are removed. Friday runs
 * inference on onnxruntime-web's WASM backend, so the native binary is never
 * needed; nothing re-fetches it on-device.
 *
 * Iterates `.pnpm/onnxruntime-node@*` rather than a single hard-coded path so it
 * catches BOTH store copies pnpm materializes when the package is patched (the
 * bare `@<v>` dir and the `@<v>_patch_hash=<hash>` dir transformers resolves
 * to). Touches ONLY `onnxruntime-node@*` dirs — `onnxruntime-web` (a different
 * package) and its `.wasm` files are left untouched. Robust no-op if no
 * onnxruntime-node copy is present (a future build that drops the dep). Returns
 * total freed bytes.
 */
function stripOnnxRuntimeBinaries(stageDir) {
  const pnpmDir = join(stageDir, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) {
    log(`  .pnpm store not present in staged tree — nothing to strip`);
    return 0;
  }
  // Every store dir named `onnxruntime-node@...` (bare + patch-hash variants).
  // Explicitly NOT matching `onnxruntime-web@...` or `onnxruntime-common@...`.
  const ortDirs = readdirSync(pnpmDir, { withFileTypes: true }).filter(
    (e) => e.isDirectory() && e.name.startsWith(ORT_PKG_GLOB_PREFIX),
  );
  if (ortDirs.length === 0) {
    log(`  no onnxruntime-node store copy in staged tree — nothing to strip`);
    return 0;
  }
  let freed = 0;
  let stripped = 0;
  for (const entry of ortDirs) {
    const binDir = join(pnpmDir, entry.name, "node_modules", "onnxruntime-node", ORT_BIN_SUBDIR);
    if (!existsSync(binDir)) continue;
    freed += dirSizeBytes(binDir);
    rmSync(binDir, { recursive: true, force: true });
    stripped++;
    log(`  stripped bin/ from ${entry.name}`);
  }
  if (stripped === 0) {
    log(`  onnxruntime-node bin/ not present in any store copy — nothing to strip`);
  }
  return freed;
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

  // Relativize absolute symlinks inside the staged tree. cpSync(dereference:
  // false) preserves whatever pnpm wrote, so on CI runners (where pnpm emits
  // absolute symlinks pointing at the runner workspace) the staged tree would
  // ship targets that don't exist on any user box. See header comment for
  // the v1.1.0 incident.
  log("relativizing symlinks");
  const { rewrote, kept } = relativizeSymlinks(stageDir, repoRoot);
  log(`  rewrote ${rewrote} absolute symlinks; kept ${kept} relative ones`);

  // Strip onnxruntime-node's ~210MB-per-copy native binary tree to keep the
  // release lean. The native backend is unused (inference is WASM via
  // onnxruntime-web), so nothing re-fetches it on-device (FRI-24). Done AFTER
  // relativizeSymlinks so the symlink walk sees the full tree, and BEFORE tar so
  // the stripped tree is what ships.
  log("stripping onnxruntime-node native binaries (FRI-24 lean tarball — WASM backend in use)");
  const freedBytes = stripOnnxRuntimeBinaries(stageDir);
  if (freedBytes > 0) {
    log(
      `  freed ${(freedBytes / (1024 * 1024)).toFixed(1)} MB of native onnxruntime-node binaries`,
    );
  }

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
