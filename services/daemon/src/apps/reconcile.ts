/**
 * Boot-time reconciliation for Friday Apps (FRI-78 §12).
 *
 * Walks the `apps` table:
 *   - folder missing → flip status to `orphaned`, do NOT touch agents/schedules.
 *   - folder present, manifest unchanged → no-op.
 *   - folder present, manifest changed → run the reload path.
 *
 * For each manifest on disk with no matching `apps` row, log a discovery
 * notice once. We never auto-install — the user must run `app_install`
 * explicitly. Auto-install would surprise a user who manually moved a
 * folder into `~/.friday/apps/` while debugging.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { appsDir, getDb, schema } from "@friday/shared";
import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";
import { reloadApp } from "./installer.js";

export async function reconcileAppsOnBoot(): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(schema.apps);
  const seenFolders = new Set<string>();
  for (const row of rows) {
    seenFolders.add(row.folderPath);
    if (!existsSync(row.folderPath)) {
      if (row.status !== "orphaned") {
        await db
          .update(schema.apps)
          .set({ status: "orphaned" })
          .where(eq(schema.apps.id, row.id));
        eventBus.publish({
          v: 1,
          type: "app_lifecycle",
          event: "orphaned",
          app: row.id,
        });
        logger.log("warn", "apps.orphaned", {
          id: row.id,
          folderPath: row.folderPath,
        });
      }
      continue;
    }
    try {
      await reloadApp(row.id);
    } catch (err) {
      logger.log("warn", "apps.reconcile.error", {
        id: row.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Surface manifests on disk that aren't in the DB yet. One log per
  // unique folder; never auto-install.
  const root = appsDir();
  if (!existsSync(root)) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const folderPath = join(root, name);
    if (seenFolders.has(folderPath)) continue;
    try {
      if (!statSync(folderPath).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(join(folderPath, "manifest.json"))) continue;
    logger.log("info", "apps.discovered.no-row", { folderPath });
  }
}
