/**
 * Phase 4.7 — apps LISTEN handler + boot-recovery scan.
 *
 * The `installApp` / `uninstallApp` / `reloadApp` mutators write
 * Postgres status transitions; this module dispatches the matching
 * daemon-side side effect. Unlike Phase 4.5 (memory) and Phase 4.6
 * (schedules), the side-effect logic ALREADY EXISTS in
 * `installer.ts` — we just have to call into it.
 *
 * Status transitions:
 *   - pending_install → installed: the dashboard wrote a stub row;
 *     read the manifest from `folder_path`, run the existing
 *     transaction-wrapped installer (agents + schedules INSERTs +
 *     manifest JSON update), and flip status='installed'. The
 *     existing `installApp` function in `installer.ts` already
 *     handles the re-install path (an existing row at status !=
 *     'pending_install' gets manifest-reconciled rather than
 *     ANOTHER stub row created).
 *
 *   - uninstall_requested → DELETED row: archive owned agents,
 *     drop schedules, optionally move folder. The existing
 *     `uninstallApp` function does this in one transaction. The
 *     row gets DELETEd at the end — Zero's view-syncer propagates
 *     that to all devices.
 *
 *   - reload_requested → installed: re-read the manifest, reconcile.
 *
 * Boot-recovery: any row still at a pending status when the daemon
 * boots was created during downtime — re-dispatch the same handler.
 */

import { eq, inArray } from "drizzle-orm";
import pgPkg from "pg";
import { getDb, getPool, schema, LISTEN_CHANNELS } from "@friday/shared";
import {
  AppInstallError,
  installApp as installerInstallApp,
  reloadApp as installerReloadApp,
  uninstallApp as installerUninstallApp,
} from "./installer.js";
import { logger } from "../log.js";

const { Client } = pgPkg;

/**
 * Process a single pending app row. Idempotent — re-running a
 * pending_install on a row whose daemon-side flip already
 * completed is a no-op (the trigger won't have fired again
 * because status moved to 'installed' which is excluded from the
 * predicate). For mid-flight crashes, the boot-recovery scan
 * picks the row back up at the same pending status.
 */
async function processPendingAppRow(id: string): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(schema.apps).where(eq(schema.apps.id, id)).limit(1);
  const row = rows[0];
  if (!row) {
    // Already DELETEd (uninstall completed). Nothing to do.
    return;
  }

  if (row.status === "pending_install") {
    try {
      const result = await installerInstallApp(row.folderPath);
      logger.log("info", "apps.sync.installed", {
        id,
        name: result.name,
        version: result.version,
      });
    } catch (err) {
      // Surface install errors by flipping status to 'error' so
      // the dashboard can render them. Manifest read failures,
      // collision errors, etc. all land here.
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof AppInstallError ? err.code : "unknown";
      await db
        .update(schema.apps)
        .set({
          status: "error",
          metaJson: { error: { message, code, at: new Date().toISOString() } },
        })
        .where(eq(schema.apps.id, id));
      logger.log("warn", "apps.sync.install-error", { id, code, message });
    }
    return;
  }

  if (row.status === "uninstall_requested") {
    try {
      await installerUninstallApp(id);
      logger.log("info", "apps.sync.uninstalled", { id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.log("warn", "apps.sync.uninstall-error", { id, message });
      // Leave the row at uninstall_requested — operator can retry.
    }
    return;
  }

  if (row.status === "reload_requested") {
    try {
      const result = await installerReloadApp(id);
      logger.log("info", "apps.sync.reloaded", {
        id,
        changed: result.changed,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof AppInstallError ? err.code : "unknown";
      await db
        .update(schema.apps)
        .set({
          status: "error",
          metaJson: { error: { message, code, at: new Date().toISOString() } },
        })
        .where(eq(schema.apps.id, id));
      logger.log("warn", "apps.sync.reload-error", { id, code, message });
    }
    return;
  }

  // Other statuses (installed, orphaned, error) — nothing to do.
}

/**
 * Boot-recovery scan: pick up any pending app rows missed during
 * daemon downtime. Same predicate as the LISTEN trigger.
 *
 * Runs AFTER `reconcileAppsOnBoot()` — the existing boot
 * reconciler handles disk-vs-DB drift (orphaned rows, folder
 * deletions). This scan handles the narrower case of dashboard-
 * mutator-initiated pending requests.
 */
export async function runAppBootScan(): Promise<void> {
  try {
    const db = getDb();
    const rows = await db
      .select({ id: schema.apps.id })
      .from(schema.apps)
      .where(
        inArray(schema.apps.status, ["pending_install", "uninstall_requested", "reload_requested"]),
      );
    for (const row of rows) {
      await processPendingAppRow(row.id);
    }
    logger.log("info", "apps.boot-scan.complete", { processed: rows.length });
  } catch (err) {
    logger.log("warn", "apps.boot-scan.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface AppListenerHandle {
  stop: () => Promise<void>;
}

export async function startAppListener(): Promise<AppListenerHandle> {
  const pool = getPool();
  const connectionString =
    (pool.options as { connectionString?: string }).connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set to start the app LISTEN connection.");
  }

  let stopped = false;
  let activeClient: InstanceType<typeof Client> | null = null;

  // FRI-121 B: reconnect loop with keepAlive + exponential backoff.
  async function connectWithRetry(): Promise<void> {
    let delay = 1_000;
    while (!stopped) {
      try {
        const c = new Client({ connectionString, keepAlive: true });
        activeClient = c;
        await c.connect();
        c.on("notification", (msg) => {
          if (msg.channel !== LISTEN_CHANNELS.appChanged) return;
          const id = msg.payload;
          if (!id) return;
          void processPendingAppRow(id).catch((err) => {
            logger.log("warn", "apps.listen.process.error", {
              id,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        });
        c.on("error", (err) => {
          logger.log("warn", "apps.listen.client.error", {
            message: err instanceof Error ? err.message : String(err),
          });
        });
        await c.query(`LISTEN ${LISTEN_CHANNELS.appChanged}`);
        logger.log("info", "apps.listen.ready", {
          channel: LISTEN_CHANNELS.appChanged,
        });
        await runAppBootScan();
        delay = 1_000;
        await new Promise<void>((resolve) => c.once("end", resolve));
      } catch (err) {
        logger.log("warn", "apps.listen.connect.error", {
          message: err instanceof Error ? err.message : String(err),
          retryIn: delay,
        });
        if (!stopped) {
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, 30_000);
        }
      } finally {
        activeClient = null;
      }
    }
  }

  void connectWithRetry();

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      if (activeClient) {
        try {
          await activeClient.query(`UNLISTEN ${LISTEN_CHANNELS.appChanged}`);
        } catch {
          // best-effort
        }
        await activeClient.end().catch(() => {});
      }
    },
  };
}
