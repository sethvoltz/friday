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

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  type Manifest,
  appDir,
  getDb,
  loadManifest,
  nextRun,
  schema,
} from "@friday/shared";
import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";
import * as registry from "../agent/registry.js";
import { archiveAgent as lifecycleArchiveAgent } from "../agent/lifecycle.js";

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
}

/**
 * Install or re-install the app whose manifest sits at
 * `<folderPath>/manifest.json`.
 */
export function installApp(
  folderPath: string,
  opts: InstallOptions = {},
): InstallResult {
  const manifest = loadManifest(folderPath);
  const db = getDb();

  // Cross-app MCP-name collision: check before opening a transaction so
  // the error path doesn't need to roll back.
  const otherApps = db
    .select()
    .from(schema.apps)
    .all()
    .filter((r) => r.id !== manifest.id);
  for (const srv of manifest.mcpServers) {
    for (const other of otherApps) {
      const otherManifest = JSON.parse(other.manifestJson) as Manifest;
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
    const existing = registry.getAgent(agent.name);
    const existingAppId = existing
      ? registry.getAppId(agent.name)
      : null;
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
    const row = db
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.name, sched.name))
      .get();
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

  const appRow = db
    .select()
    .from(schema.apps)
    .where(eq(schema.apps.id, manifest.id))
    .get();

  const now = new Date();
  const manifestJson = JSON.stringify(manifest);
  const isReinstall = appRow != null;

  if (appRow && appRow.status === "installed") {
    // §6.1 step 2: already installed → reject. Reload is the path for
    // a manifest-edit re-read.
    throw new AppInstallError(
      `app "${manifest.id}" is already installed; use reload to re-read the manifest`,
      "already_installed",
    );
  }

  db.transaction((tx) => {
    if (appRow) {
      tx.update(schema.apps)
        .set({
          name: manifest.name,
          version: manifest.version,
          manifestVersion: manifest.manifestVersion,
          folderPath,
          manifestJson,
          status: "installed",
          upgradedAt: now,
        })
        .where(eq(schema.apps.id, manifest.id))
        .run();
    } else {
      tx.insert(schema.apps)
        .values({
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          manifestVersion: manifest.manifestVersion,
          folderPath,
          manifestJson,
          status: "installed",
          installedAt: now,
          upgradedAt: null,
        })
        .run();
    }

    for (const agent of manifest.agents) {
      const dispo = dispositions.get(agent.name)!;
      switch (dispo.kind) {
        case "create": {
          tx.insert(schema.agents)
            .values({
              name: agent.name,
              type: agent.type,
              status: "idle",
              appId: manifest.id,
              createdAt: now,
              updatedAt: now,
            })
            .run();
          break;
        }
        case "noop":
          break;
        case "unarchive": {
          tx.update(schema.agents)
            .set({
              status: "idle",
              appId: manifest.id,
              updatedAt: now,
              ...(dispo.clearSession ? { sessionId: null } : {}),
            })
            .where(eq(schema.agents.name, agent.name))
            .run();
          break;
        }
        case "rebind": {
          tx.update(schema.agents)
            .set({
              appId: manifest.id,
              type: agent.type,
              updatedAt: now,
              ...(dispo.wasArchived ? { status: "idle" } : {}),
              ...(dispo.clearSession ? { sessionId: null } : {}),
            })
            .where(eq(schema.agents.name, agent.name))
            .run();
          break;
        }
      }
    }

    // Schedules: upsert each. Same-app reinstall overwrites cron/prompt.
    const declaredScheduleNames = new Set(manifest.schedules.map((s) => s.name));
    for (const s of manifest.schedules) {
      const existing = tx
        .select()
        .from(schema.schedules)
        .where(eq(schema.schedules.name, s.name))
        .get();
      const next = computeNextRun(s.cron);
      if (existing) {
        tx.update(schema.schedules)
          .set({
            cron: s.cron,
            runAt: null,
            taskPrompt: s.taskPrompt,
            paused: false,
            nextRunAt: next,
            appId: manifest.id,
            updatedAt: Date.now(),
          })
          .where(eq(schema.schedules.name, s.name))
          .run();
      } else {
        tx.insert(schema.schedules)
          .values({
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
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          .run();
      }
    }

    // Reinstall: drop schedule rows owned by us that disappeared from
    // the manifest. Same idea as the §6.4 reload path.
    if (isReinstall) {
      const ourSchedules = tx
        .select()
        .from(schema.schedules)
        .where(eq(schema.schedules.appId, manifest.id))
        .all();
      for (const row of ourSchedules) {
        if (!declaredScheduleNames.has(row.name)) {
          tx.delete(schema.schedules)
            .where(eq(schema.schedules.name, row.name))
            .run();
        }
      }
    }
  });

  // Post-commit: best-effort side effects. None of these may unwind.
  ensureGitignore(folderPath);
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
  });

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    status: "installed",
    agents: manifest.agents.map((a) => ({ name: a.name, type: a.type })),
    schedules: manifest.schedules.map((s) => ({ name: s.name, cron: s.cron })),
    mcpServers: manifest.mcpServers.map((m) => ({ name: m.name })),
  };
}

export type FolderDisposition = "archive" | "keep" | "delete";

export interface UninstallResult {
  id: string;
  folderDisposition: FolderDisposition;
  archivedFolderPath?: string;
}

export function uninstallApp(
  id: string,
  opts: { folderDisposition?: FolderDisposition } = {},
): UninstallResult {
  const folderDisposition = opts.folderDisposition ?? "archive";
  const db = getDb();
  const row = db
    .select()
    .from(schema.apps)
    .where(eq(schema.apps.id, id))
    .get();
  if (!row) {
    throw new AppInstallError(`app "${id}" is not installed`, "not_installed");
  }

  // Capture the agents owned by this app *before* tearing down so we can
  // archive them outside the transaction (archive does worker teardown).
  const ourAgents = db
    .select({ name: schema.agents.name })
    .from(schema.agents)
    .where(eq(schema.agents.appId, id))
    .all()
    .map((r) => r.name);

  // Archive workers + agents. `archiveAgent` is fire-and-forget for our
  // purposes — it handles worker teardown + linked-ticket close. We do
  // NOT clear `appId`: the tombstone lets reinstall un-archive the row.
  for (const name of ourAgents) {
    void lifecycleArchiveAgent(name, { reason: "abandoned" });
  }

  db.transaction((tx) => {
    tx.delete(schema.schedules)
      .where(eq(schema.schedules.appId, id))
      .run();
    tx.delete(schema.apps).where(eq(schema.apps.id, id)).run();
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
export function reloadApp(id: string): { id: string; changed: boolean } {
  const db = getDb();
  const row = db
    .select()
    .from(schema.apps)
    .where(eq(schema.apps.id, id))
    .get();
  if (!row) {
    throw new AppInstallError(`app "${id}" is not installed`, "not_installed");
  }
  if (!existsSync(row.folderPath)) {
    db.update(schema.apps)
      .set({ status: "orphaned" })
      .where(eq(schema.apps.id, id))
      .run();
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
  const manifestJson = JSON.stringify(manifest);
  if (manifestJson === row.manifestJson && row.status === "installed") {
    return { id, changed: false };
  }

  const now = new Date();
  db.transaction((tx) => {
    tx.update(schema.apps)
      .set({
        name: manifest.name,
        version: manifest.version,
        manifestVersion: manifest.manifestVersion,
        manifestJson,
        status: "installed",
        upgradedAt: now,
      })
      .where(eq(schema.apps.id, id))
      .run();

    // Create new agents listed in manifest. Never overwrite live rows.
    for (const agent of manifest.agents) {
      const existing = tx
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.name, agent.name))
        .get();
      if (!existing) {
        tx.insert(schema.agents)
          .values({
            name: agent.name,
            type: agent.type,
            status: "idle",
            appId: id,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
    }

    // Reconcile schedules: upsert all manifest-declared, drop ours that
    // disappeared.
    const declared = new Set(manifest.schedules.map((s) => s.name));
    for (const s of manifest.schedules) {
      const next = computeNextRun(s.cron);
      const existing = tx
        .select()
        .from(schema.schedules)
        .where(eq(schema.schedules.name, s.name))
        .get();
      if (existing) {
        tx.update(schema.schedules)
          .set({
            cron: s.cron,
            runAt: null,
            taskPrompt: s.taskPrompt,
            nextRunAt: next,
            appId: id,
            updatedAt: Date.now(),
          })
          .where(eq(schema.schedules.name, s.name))
          .run();
      } else {
        tx.insert(schema.schedules)
          .values({
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
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          .run();
      }
    }
    const ours = tx
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.appId, id))
      .all();
    for (const r of ours) {
      if (!declared.has(r.name)) {
        tx.delete(schema.schedules)
          .where(eq(schema.schedules.name, r.name))
          .run();
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

export function listApps(): AppListing[] {
  const db = getDb();
  return db
    .select()
    .from(schema.apps)
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      version: r.version,
      status: r.status,
      installedAt: new Date(r.installedAt).getTime(),
      folderPath: r.folderPath,
    }));
}

export interface AppInspection extends AppListing {
  manifest: Manifest;
  agents: { name: string; type: string; status: string }[];
  schedules: { name: string; cron: string | null }[];
  mcpServers: { name: string }[];
}

export function inspectApp(id: string): AppInspection | null {
  const db = getDb();
  const row = db
    .select()
    .from(schema.apps)
    .where(eq(schema.apps.id, id))
    .get();
  if (!row) return null;
  const manifest = JSON.parse(row.manifestJson) as Manifest;
  const agents = db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.appId, id))
    .all()
    .map((a) => ({ name: a.name, type: a.type, status: a.status }));
  const schedules = db
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.appId, id))
    .all()
    .map((s) => ({ name: s.name, cron: s.cron }));
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    status: row.status,
    installedAt: new Date(row.installedAt).getTime(),
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
export function appFolderForAgent(agentName: string): string | null {
  const id = registry.getAppId(agentName);
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
export function appContextForAgent(
  agentName: string,
): AppContextForWorker | null {
  const appId = registry.getAppId(agentName);
  if (!appId) return null;
  const db = getDb();
  const row = db
    .select()
    .from(schema.apps)
    .where(eq(schema.apps.id, appId))
    .get();
  if (!row || row.status !== "installed") return null;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(row.manifestJson) as Manifest;
  } catch {
    return null;
  }
  const envFile = readAppEnv(row.folderPath);
  return {
    appId,
    folderPath: row.folderPath,
    mcpServers: manifest.mcpServers,
    envFile,
  };
}

function readAppEnv(folderPath: string): Record<string, string> | undefined {
  const envPath = join(folderPath, ".env");
  if (!existsSync(envPath)) return undefined;
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
    return undefined;
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

function computeNextRun(cron: string): number | null {
  const d = nextRun(cron);
  return d ? d.getTime() : null;
}
