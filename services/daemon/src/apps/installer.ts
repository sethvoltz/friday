/**
 * Friday Apps installer (FRI-78).
 *
 * Atomic install / uninstall / reload of an `~/.friday/apps/<id>/`
 * directory. The on-disk `manifest.json` is the source of truth; the
 * `apps` SQLite table is derived state we reconcile against it.
 *
 * All collision checks + writes happen inside a single SQLite
 * transaction so a partial install can never leave the DB inconsistent.
 * Post-commit side-effects (gitignore drop, SSE publish, folder rename)
 * are best-effort: their failure logs a warning but does not unwind
 * the install.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  type Manifest,
  appDir,
  getDb,
  getVaultCache,
  loadManifest,
  nextRun,
  schema,
  vaultKeyForMeta,
} from "@friday/shared";
import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";
import * as registry from "../agent/registry.js";
import { archiveAgent as lifecycleArchiveAgent } from "../agent/lifecycle.js";
import { captureFor } from "../posthog.js";

type PackageManager = "pnpm" | "yarn" | "npm";

/** Hard ceiling for a dependency install. SIGTERM at the deadline, SIGKILL 5s after. */
const DEP_INSTALL_TIMEOUT_MS = 5 * 60_000;
/** Cap stdout/stderr captured in the install result so a noisy install doesn't blow up the HTTP response. */
const DEP_INSTALL_OUTPUT_TAIL_BYTES = 4_000;

export type DependencyInstallOutcome =
  | { ran: false }
  | {
      ran: true;
      packageManager: PackageManager;
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
      warning?: string;
    };

export class AppInstallError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "AppInstallError";
  }
}

export interface InstallOptions {
  /**
   * When true, agent rows owned by *other* apps (or unaffiliated rows)
   * with a matching name can be rebound to this app without failing.
   * Default false — name collisions on live unaffiliated agents fail
   * fast and ask the operator to archive first.
   */
  adopt?: boolean;
}

export interface InstallResult {
  id: string;
  name: string;
  version: string;
  status: "installed";
  agents: { name: string; type: "bare" | "scheduled" }[];
  schedules: { name: string; cron: string }[];
  mcpServers: { name: string }[];
  dependencies: DependencyInstallOutcome;
}

/**
 * Install or re-install the app whose manifest sits at
 * `<folderPath>/manifest.json`.
 */
export async function installApp(
  folderPath: string,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const manifest = loadManifest(folderPath);
  const db = getDb();

  // Cross-app MCP-name collision: check before opening a transaction so
  // the error path doesn't need to roll back. `manifestJson` is jsonb so
  // Drizzle returns it parsed.
  const allApps = await db.select().from(schema.apps);
  const otherApps = allApps.filter((r) => r.id !== manifest.id);
  for (const srv of manifest.mcpServers) {
    for (const other of otherApps) {
      const otherManifest = other.manifestJson as Manifest;
      if (otherManifest.mcpServers.some((s) => s.name === srv.name)) {
        throw new AppInstallError(
          `mcpServer name "${srv.name}" already declared by installed app "${other.id}"`,
          "mcp_name_collision",
        );
      }
    }
  }

  // Pre-flight agent disposition: figure out for each manifest agent what
  // we'd do. If any disposition is `fail`, throw *before* touching the
  // DB. This is the "no DB writes happen" guarantee from §16.6.
  type Dispo =
    | { kind: "create" }
    | { kind: "noop" }
    | { kind: "unarchive"; clearSession: boolean }
    | { kind: "rebind"; clearSession: boolean; wasArchived: boolean };
  const dispositions = new Map<string, Dispo>();
  for (const agent of manifest.agents) {
    const existing = await registry.getAgent(agent.name);
    const existingAppId = existing ? await registry.getAppId(agent.name) : null;
    if (!existing) {
      dispositions.set(agent.name, { kind: "create" });
      continue;
    }
    const sameApp = existingAppId === manifest.id;
    const archived = existing.status === "archived";
    if (sameApp && archived) {
      dispositions.set(agent.name, { kind: "unarchive", clearSession: false });
      continue;
    }
    if (sameApp && !archived) {
      dispositions.set(agent.name, { kind: "noop" });
      continue;
    }
    // Different owner (or unaffiliated)
    if (archived) {
      dispositions.set(agent.name, {
        kind: "rebind",
        clearSession: !opts.adopt,
        wasArchived: true,
      });
      continue;
    }
    if (opts.adopt) {
      dispositions.set(agent.name, {
        kind: "rebind",
        clearSession: false,
        wasArchived: false,
      });
      continue;
    }
    throw new AppInstallError(
      `agent "${agent.name}" already exists (status=${existing.status}, app=${existingAppId ?? "none"}); archive it first or install with adopt=true`,
      "agent_name_collision",
    );
  }

  // Schedule name collisions: only fail if the existing schedule is
  // owned by a different app. Same-app reinstall reuses the row.
  for (const sched of manifest.schedules) {
    const rows = await db
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.name, sched.name))
      .limit(1);
    const row = rows[0];
    if (row && row.appId && row.appId !== manifest.id) {
      throw new AppInstallError(
        `schedule "${sched.name}" already declared by installed app "${row.appId}"`,
        "schedule_name_collision",
      );
    }
    if (row && !row.appId) {
      throw new AppInstallError(
        `schedule "${sched.name}" already exists as an unaffiliated schedule; remove it first or rename the manifest entry`,
        "schedule_name_collision",
      );
    }
  }

  const appRows = await db
    .select()
    .from(schema.apps)
    .where(eq(schema.apps.id, manifest.id))
    .limit(1);
  const appRow = appRows[0];

  const now = new Date();
  // Store manifest as parsed jsonb; Drizzle accepts the object directly.
  const manifestParsed = manifest as unknown as Record<string, unknown>;
  const isReinstall = appRow != null;

  if (appRow && appRow.status === "installed") {
    // §6.1 step 2: already installed → reject. Reload is the path for
    // a manifest-edit re-read.
    throw new AppInstallError(
      `app "${manifest.id}" is already installed; use reload to re-read the manifest`,
      "already_installed",
    );
  }

  await db.transaction(async (tx) => {
    if (appRow) {
      await tx
        .update(schema.apps)
        .set({
          name: manifest.name,
          version: manifest.version,
          manifestVersion: manifest.manifestVersion,
          folderPath,
          manifestJson: manifestParsed,
          status: "installed",
          upgradedAt: now,
        })
        .where(eq(schema.apps.id, manifest.id));
    } else {
      await tx.insert(schema.apps).values({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        manifestVersion: manifest.manifestVersion,
        folderPath,
        manifestJson: manifestParsed,
        status: "installed",
        installedAt: now,
        upgradedAt: null,
      });
    }

    for (const agent of manifest.agents) {
      const dispo = dispositions.get(agent.name)!;
      switch (dispo.kind) {
        case "create": {
          await tx.insert(schema.agents).values({
            name: agent.name,
            type: agent.type,
            status: "idle",
            appId: manifest.id,
            createdAt: now,
            updatedAt: now,
          });
          break;
        }
        case "noop":
          break;
        case "unarchive": {
          // Reset archive_reason when bringing a row back to idle —
          // leaving stale `completed`/`abandoned`/`failed` on a live
          // agent confuses both the dashboard's archive UI and any
          // future debugging.
          await tx
            .update(schema.agents)
            .set({
              status: "idle",
              archiveReason: null,
              appId: manifest.id,
              updatedAt: now,
              ...(dispo.clearSession ? { sessionId: null } : {}),
            })
            .where(eq(schema.agents.name, agent.name));
          break;
        }
        case "rebind": {
          await tx
            .update(schema.agents)
            .set({
              appId: manifest.id,
              type: agent.type,
              updatedAt: now,
              ...(dispo.wasArchived ? { status: "idle", archiveReason: null } : {}),
              ...(dispo.clearSession ? { sessionId: null } : {}),
            })
            .where(eq(schema.agents.name, agent.name));
          break;
        }
      }
    }

    // Schedules: upsert each. Same-app reinstall overwrites cron/prompt.
    const declaredScheduleNames = new Set(manifest.schedules.map((s) => s.name));
    for (const s of manifest.schedules) {
      const existingRows = await tx
        .select()
        .from(schema.schedules)
        .where(eq(schema.schedules.name, s.name))
        .limit(1);
      const next = computeNextRun(s.cron);
      if (existingRows[0]) {
        await tx
          .update(schema.schedules)
          .set({
            cron: s.cron,
            runAt: null,
            taskPrompt: s.taskPrompt,
            paused: false,
            nextRunAt: next,
            appId: manifest.id,
            updatedAt: new Date(),
          })
          .where(eq(schema.schedules.name, s.name));
      } else {
        await tx.insert(schema.schedules).values({
          name: s.name,
          cron: s.cron,
          runAt: null,
          taskPrompt: s.taskPrompt,
          paused: false,
          nextRunAt: next,
          lastRunAt: null,
          lastRunId: null,
          metaJson: null,
          appId: manifest.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    // Reinstall: drop schedule rows owned by us that disappeared from
    // the manifest. Same idea as the §6.4 reload path.
    if (isReinstall) {
      const ourSchedules = await tx
        .select()
        .from(schema.schedules)
        .where(eq(schema.schedules.appId, manifest.id));
      for (const row of ourSchedules) {
        if (!declaredScheduleNames.has(row.name)) {
          await tx.delete(schema.schedules).where(eq(schema.schedules.name, row.name));
        }
      }
    }
  });

  // Post-commit: best-effort side effects. None of these may unwind.
  ensureGitignore(folderPath);
  const dependencies = await installAppDependencies(folderPath, manifest.id);
  eventBus.publish({
    v: 1,
    type: "app_lifecycle",
    event: "installed",
    app: manifest.id,
    version: manifest.version,
  });
  logger.log("info", "apps.installed", {
    id: manifest.id,
    version: manifest.version,
    reinstall: isReinstall,
    adopt: opts.adopt ?? false,
    depsRan: dependencies.ran,
    depsWarning: dependencies.ran ? (dependencies.warning ?? null) : null,
  });

  const result: InstallResult = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    status: "installed",
    agents: manifest.agents.map((a) => ({ name: a.name, type: a.type })),
    schedules: manifest.schedules.map((s) => ({ name: s.name, cron: s.cron })),
    mcpServers: manifest.mcpServers.map((m) => ({ name: m.name })),
    dependencies,
  };
  captureFor(null, "app_installed", {
    app_id: manifest.id,
    app_name: manifest.name,
    app_version: manifest.version,
    is_reinstall: isReinstall,
    agent_count: manifest.agents.length,
    schedule_count: manifest.schedules.length,
    mcp_server_count: manifest.mcpServers.length,
    deps_installed: dependencies.ran,
  });
  return result;
}

/**
 * Run `<pkg-mgr> install` inside the app folder when it ships a `package.json`.
 *
 * Lock-file detection picks the manager: pnpm-lock.yaml → pnpm, yarn.lock → yarn,
 * package-lock.json → npm, no lockfile → npm fallback. Failures (non-zero exit,
 * timeout, ENOENT) warn-and-continue: the app row is already committed, so we
 * surface the warning in the result rather than tear down state we can't safely
 * roll back. App `package.json` lifecycle scripts (postinstall etc.) DO run —
 * the user trusted the folder by installing it.
 */
async function installAppDependencies(
  folderPath: string,
  appId: string,
): Promise<DependencyInstallOutcome> {
  if (!existsSync(join(folderPath, "package.json"))) return { ran: false };
  const manager = detectPackageManager(folderPath);
  const startedAt = Date.now();
  const outcome = await runInstallProcess(manager, folderPath);
  const durationMs = Date.now() - startedAt;
  const result: DependencyInstallOutcome = {
    ran: true,
    packageManager: manager,
    exitCode: outcome.exitCode,
    stdout: tailOutput(outcome.stdout),
    stderr: tailOutput(outcome.stderr),
    durationMs,
    warning: outcome.warning,
  };
  if (outcome.warning) {
    logger.log("warn", "apps.install.deps.error", {
      id: appId,
      folderPath,
      packageManager: manager,
      exitCode: outcome.exitCode,
      durationMs,
      message: outcome.warning,
    });
  } else {
    logger.log("info", "apps.install.deps", {
      id: appId,
      folderPath,
      packageManager: manager,
      durationMs,
    });
  }
  return result;
}

function detectPackageManager(folderPath: string): PackageManager {
  if (existsSync(join(folderPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(folderPath, "yarn.lock"))) return "yarn";
  if (existsSync(join(folderPath, "package-lock.json"))) return "npm";
  return "npm";
}

interface RawInstallOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  warning?: string;
}

function runInstallProcess(manager: PackageManager, cwd: string): Promise<RawInstallOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const settle = (outcome: RawInstallOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const child = spawn(manager, ["install"], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Grace period before SIGKILL so the manager can flush cache state.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 5_000).unref();
    }, DEP_INSTALL_TIMEOUT_MS);
    timer.unref();

    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      settle({
        exitCode: -1,
        stdout,
        stderr: stderr ? `${stderr}\nspawn error: ${err.message}` : `spawn error: ${err.message}`,
        warning: `failed to spawn ${manager}: ${err.message}`,
      });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const exitCode = code ?? (signal ? -1 : 0);
      const ok = !timedOut && code === 0;
      const warning = timedOut
        ? `dependency install timed out after ${DEP_INSTALL_TIMEOUT_MS / 1000}s; killed`
        : ok
          ? undefined
          : `${manager} install exited with code ${exitCode}${signal ? ` (signal ${signal})` : ""}`;
      settle({ exitCode, stdout, stderr, warning });
    });
  });
}

function tailOutput(s: string): string {
  if (s.length <= DEP_INSTALL_OUTPUT_TAIL_BYTES) return s;
  return `…[truncated ${s.length - DEP_INSTALL_OUTPUT_TAIL_BYTES} bytes]…\n${s.slice(-DEP_INSTALL_OUTPUT_TAIL_BYTES)}`;
}

export type FolderDisposition = "archive" | "keep" | "delete";

export interface UninstallResult {
  id: string;
  folderDisposition: FolderDisposition;
  archivedFolderPath?: string;
}

export async function uninstallApp(
  id: string,
  opts: { folderDisposition?: FolderDisposition } = {},
): Promise<UninstallResult> {
  const folderDisposition = opts.folderDisposition ?? "archive";
  const db = getDb();
  const rows = await db.select().from(schema.apps).where(eq(schema.apps.id, id)).limit(1);
  const row = rows[0];
  if (!row) {
    throw new AppInstallError(`app "${id}" is not installed`, "not_installed");
  }

  // Capture the agents owned by this app *before* tearing down so we can
  // archive them outside the transaction (archive does worker teardown).
  const ourAgentRows = await db
    .select({ name: schema.agents.name })
    .from(schema.agents)
    .where(eq(schema.agents.appId, id));
  const ourAgents = ourAgentRows.map((r) => r.name);

  // Archive workers + agents. `archiveAgent` is fire-and-forget for our
  // purposes — it handles worker teardown + linked-ticket close. We do
  // NOT clear `appId`: the tombstone lets reinstall un-archive the row.
  for (const name of ourAgents) {
    void lifecycleArchiveAgent(name, { reason: "abandoned" });
  }

  await db.transaction(async (tx) => {
    await tx.delete(schema.schedules).where(eq(schema.schedules.appId, id));
    await tx.delete(schema.apps).where(eq(schema.apps.id, id));
  });

  const result: UninstallResult = { id, folderDisposition };

  if (existsSync(row.folderPath)) {
    if (folderDisposition === "archive") {
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace(/T/, "_")
        .replace(/Z$/, "");
      const target = `${row.folderPath}.uninstalled-${stamp}`;
      try {
        renameSync(row.folderPath, target);
        result.archivedFolderPath = target;
      } catch (err) {
        logger.log("warn", "apps.uninstall.archive.error", {
          id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (folderDisposition === "delete") {
      logger.log("warn", "apps.uninstall.folder.delete", {
        id,
        folderPath: row.folderPath,
      });
      try {
        rmSync(row.folderPath, { recursive: true, force: true });
      } catch (err) {
        logger.log("warn", "apps.uninstall.delete.error", {
          id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // "keep" leaves the folder in place; nothing to do.
  }

  eventBus.publish({
    v: 1,
    type: "app_lifecycle",
    event: "uninstalled",
    app: id,
  });
  logger.log("info", "apps.uninstalled", { id, folderDisposition });
  return result;
}

/**
 * Re-read the on-disk manifest and reconcile. No-op if unchanged.
 * Does NOT auto-archive agents removed from the manifest — that's
 * destructive; explicit uninstall is required for archival.
 */
export async function reloadApp(id: string): Promise<{ id: string; changed: boolean }> {
  const db = getDb();
  const rows = await db.select().from(schema.apps).where(eq(schema.apps.id, id)).limit(1);
  const row = rows[0];
  if (!row) {
    throw new AppInstallError(`app "${id}" is not installed`, "not_installed");
  }
  if (!existsSync(row.folderPath)) {
    await db.update(schema.apps).set({ status: "orphaned" }).where(eq(schema.apps.id, id));
    eventBus.publish({
      v: 1,
      type: "app_lifecycle",
      event: "orphaned",
      app: id,
    });
    logger.log("warn", "apps.orphaned", { id, folderPath: row.folderPath });
    return { id, changed: true };
  }
  const manifest = loadManifest(row.folderPath);
  if (manifest.id !== id) {
    throw new AppInstallError(
      `manifest id "${manifest.id}" does not match folder id "${id}"`,
      "manifest_id_mismatch",
    );
  }
  const manifestParsed = manifest as unknown as Record<string, unknown>;
  // Compare structurally: jsonb storage doesn't preserve key order on
  // round-trip, so we canonicalize both sides (sort keys recursively)
  // before stringifying. Without this every reload looks "changed" even
  // when the manifest on disk hasn't been touched.
  const existingManifestJson = canonicalJson(row.manifestJson);
  const incomingManifestJson = canonicalJson(manifest);
  if (existingManifestJson === incomingManifestJson && row.status === "installed") {
    return { id, changed: false };
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(schema.apps)
      .set({
        name: manifest.name,
        version: manifest.version,
        manifestVersion: manifest.manifestVersion,
        manifestJson: manifestParsed,
        status: "installed",
        upgradedAt: now,
      })
      .where(eq(schema.apps.id, id));

    // Create new agents listed in manifest. Never overwrite live rows.
    for (const agent of manifest.agents) {
      const existingRows = await tx
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.name, agent.name))
        .limit(1);
      if (!existingRows[0]) {
        await tx.insert(schema.agents).values({
          name: agent.name,
          type: agent.type,
          status: "idle",
          appId: id,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // Reconcile schedules: upsert all manifest-declared, drop ours that
    // disappeared.
    const declared = new Set(manifest.schedules.map((s) => s.name));
    for (const s of manifest.schedules) {
      const next = computeNextRun(s.cron);
      const existingRows = await tx
        .select()
        .from(schema.schedules)
        .where(eq(schema.schedules.name, s.name))
        .limit(1);
      if (existingRows[0]) {
        await tx
          .update(schema.schedules)
          .set({
            cron: s.cron,
            runAt: null,
            taskPrompt: s.taskPrompt,
            nextRunAt: next,
            appId: id,
            updatedAt: new Date(),
          })
          .where(eq(schema.schedules.name, s.name));
      } else {
        await tx.insert(schema.schedules).values({
          name: s.name,
          cron: s.cron,
          runAt: null,
          taskPrompt: s.taskPrompt,
          paused: false,
          nextRunAt: next,
          lastRunAt: null,
          lastRunId: null,
          metaJson: null,
          appId: id,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }
    const ours = await tx.select().from(schema.schedules).where(eq(schema.schedules.appId, id));
    for (const r of ours) {
      if (!declared.has(r.name)) {
        await tx.delete(schema.schedules).where(eq(schema.schedules.name, r.name));
      }
    }
  });

  eventBus.publish({
    v: 1,
    type: "app_lifecycle",
    event: "reloaded",
    app: id,
    version: manifest.version,
  });
  logger.log("info", "apps.reloaded", { id, version: manifest.version });
  return { id, changed: true };
}

export interface AppListing {
  id: string;
  name: string;
  version: string;
  status: string;
  installedAt: number;
  folderPath: string;
}

export async function listApps(): Promise<AppListing[]> {
  const db = getDb();
  const rows = await db.select().from(schema.apps);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    version: r.version,
    status: r.status,
    installedAt: r.installedAt.getTime(),
    folderPath: r.folderPath,
  }));
}

export interface AppInspection extends AppListing {
  manifest: Manifest;
  agents: { name: string; type: string; status: string }[];
  schedules: { name: string; cron: string | null }[];
  mcpServers: { name: string }[];
}

export async function inspectApp(id: string): Promise<AppInspection | null> {
  const db = getDb();
  const rows = await db.select().from(schema.apps).where(eq(schema.apps.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const manifest = row.manifestJson as Manifest;
  const agentRows = await db.select().from(schema.agents).where(eq(schema.agents.appId, id));
  const agents = agentRows.map((a) => ({
    name: a.name,
    type: a.type,
    status: a.status,
  }));
  const scheduleRows = await db
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.appId, id));
  const schedules = scheduleRows.map((s) => ({ name: s.name, cron: s.cron }));
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    status: row.status,
    installedAt: row.installedAt.getTime(),
    folderPath: row.folderPath,
    manifest,
    agents,
    schedules,
    mcpServers: manifest.mcpServers.map((m) => ({ name: m.name })),
  };
}

/** Resolve the app folder for a worker spawn. Null when the agent has
 *  no `app_id` set. Pure DB lookup; used by the worker spawn site so
 *  there's no need to round-trip through the manifest cache. */
export async function appFolderForAgent(agentName: string): Promise<string | null> {
  const id = await registry.getAppId(agentName);
  if (!id) return null;
  return appDir(id);
}

export interface AppContextForWorker {
  appId: string;
  folderPath: string;
  mcpServers: Manifest["mcpServers"];
  envFile?: Record<string, string>;
}

/**
 * Build the `appContext` field for a worker spawn. Returns null when the
 * agent isn't part of an installed app. Reads the app's `.env` if present,
 * parsing simple `KEY=VALUE` lines (no shell expansion); failures degrade
 * to an empty `envFile` rather than throwing — a worker should still
 * boot even if the secrets file is malformed.
 */
export async function appContextForAgent(agentName: string): Promise<AppContextForWorker | null> {
  const appId = await registry.getAppId(agentName);
  if (!appId) return null;
  const db = getDb();
  const rows = await db.select().from(schema.apps).where(eq(schema.apps.id, appId)).limit(1);
  const row = rows[0];
  if (!row || row.status !== "installed") return null;
  let manifest: Manifest;
  try {
    manifest = row.manifestJson as Manifest;
  } catch {
    return null;
  }
  const envFile = readAppEnv(appId, row.folderPath);
  return {
    appId,
    folderPath: row.folderPath,
    mcpServers: manifest.mcpServers,
    envFile,
  };
}

function readAppEnv(appId: string, folderPath: string): Record<string, string> | undefined {
  const legacy = readLegacyAppDotEnv(folderPath);
  const fromVault: Record<string, string> = {};
  const cache = getVaultCache();
  if (cache) {
    for (const meta of cache.meta.secrets) {
      if (meta.app !== appId || meta.mode !== "env") continue;
      const value = cache.payload.secrets[vaultKeyForMeta(meta)]?.value;
      if (value !== undefined) fromVault[meta.name] = value;
    }
  }
  const merged = { ...legacy, ...fromVault };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function readLegacyAppDotEnv(folderPath: string): Record<string, string> {
  const envPath = join(folderPath, ".env");
  if (!existsSync(envPath)) return {};
  try {
    const text = readFileSync(envPath, "utf8");
    const out: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch (err) {
    logger.log("warn", "apps.env.parse.error", {
      folderPath,
      message: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

function ensureGitignore(folderPath: string): void {
  const target = join(folderPath, ".gitignore");
  if (existsSync(target)) return;
  try {
    writeFileSync(target, ".env\nstate/*.cache.json\n");
  } catch (err) {
    logger.log("warn", "apps.gitignore.error", {
      folderPath,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function computeNextRun(cron: string): Date | null {
  return nextRun(cron);
}

/**
 * JSON-stringify with object keys sorted recursively. Used by `reloadApp`
 * to compare the on-disk manifest against the DB row's manifestJson: the
 * jsonb round-trip rearranges keys, so a byte-for-byte stringify diff
 * spuriously reports `changed: true` on every reload.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}
