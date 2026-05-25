/**
 * Phase 4.3 — Settings LISTEN handler + boot-recovery scan.
 *
 * The `updateSettings` mutator UPSERTs the singleton row in the
 * `settings` table; a Postgres trigger (`friday_settings_notify`) on
 * UPDATE fires `NOTIFY friday_settings_changed`. This module owns the
 * receiving side:
 *
 *   - `runSettingsBootScan()` reads the row once at daemon boot and
 *     reconciles `~/.friday/config.json` so any settings change that
 *     landed while the daemon was down is applied before the first
 *     worker spawns. Plan §5: every LISTEN handler has a matching
 *     boot-recovery scan with the same predicate; this is it.
 *
 *   - `startSettingsListener()` opens a dedicated `pg.Client` (NOT a
 *     pooled connection — LISTEN requires a long-lived socket; pooled
 *     clients return to the pool after each query and the
 *     subscription dies). On each NOTIFY, re-runs the same sync
 *     function as boot. Returns a `stop()` for shutdown cleanup.
 *
 *   - `syncConfigFromSettingsRow()` is the load-bearing helper —
 *     idempotent on (DB row → file contents). Re-running with no
 *     change rewrites the file with identical bytes (mtime advances;
 *     content does not). Worker spawns pick up the new model /
 *     watchdogRefork on next `loadConfig()` call (every spawn reads
 *     fresh from disk — no in-memory cache to invalidate).
 *
 * Idempotency contract: this handler is safe to run at any time. The
 * NOTIFY payload is ignored (the row state is the source of truth);
 * a duplicate notification just reruns the sync, which is a no-op
 * when the row hasn't actually changed.
 */

import { eq } from "drizzle-orm";
import pgPkg from "pg";
import {
  getDb,
  getPool,
  loadConfig,
  schema,
  writeConfig,
  LISTEN_CHANNELS,
  type FridayConfig,
} from "@friday/shared";
import { logger } from "../log.js";

const { Client } = pgPkg;

const SINGLETON_KEY = "singleton";

/**
 * Apply the current settings-row values to `~/.friday/config.json`.
 * Returns `true` when the file was actually rewritten (i.e., values
 * differed), `false` when the row matched config.json already.
 *
 * Only touches the user-toggleable fields (`model`, `watchdog.refork`);
 * structural fields (ports, mcpServers, base URLs) are preserved
 * because they're not in the settings table.
 */
async function syncConfigFromSettingsRow(): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.id, SINGLETON_KEY))
    .limit(1);
  const row = rows[0];
  if (!row) {
    // No singleton row yet — migration seeded it, so this shouldn't
    // happen in steady state. Log and bail rather than throw.
    logger.log("warn", "settings.sync.no-row", {});
    return false;
  }

  const cfg = loadConfig();
  let changed = false;

  if (row.model !== null && row.model !== cfg.model) {
    cfg.model = row.model;
    changed = true;
  }
  if (row.watchdogRefork !== null && (cfg.watchdog?.refork ?? false) !== row.watchdogRefork) {
    const watchdog: NonNullable<FridayConfig["watchdog"]> = {
      ...(cfg.watchdog ?? {}),
      refork: row.watchdogRefork,
    };
    cfg.watchdog = watchdog;
    changed = true;
  }

  if (changed) {
    writeConfig(cfg);
    logger.log("info", "settings.sync.applied", {
      model: row.model,
      watchdogRefork: row.watchdogRefork,
    });
  }
  return changed;
}

/**
 * Boot-recovery scan: read the singleton settings row and reconcile
 * `~/.friday/config.json` once at startup. Catches the case where the
 * user updated settings while the daemon was down — the LISTEN
 * subscription is offline during that window, so without this scan
 * the next worker spawn would use stale config.
 */
export async function runSettingsBootScan(): Promise<void> {
  try {
    const changed = await syncConfigFromSettingsRow();
    logger.log("info", "settings.boot-scan.complete", { changed });
  } catch (err) {
    logger.log("warn", "settings.boot-scan.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface SettingsListenerHandle {
  stop: () => Promise<void>;
}

/**
 * Start the long-lived LISTEN connection. Returns a handle whose
 * `stop()` shuts down the client cleanly on daemon shutdown.
 *
 * The Postgres connection used here is dedicated: pulled from the
 * pool, never released back to it. Pooled connections rotate, but
 * LISTEN subscriptions are bound to the underlying socket, so a
 * rotated connection silently drops the subscription. We use the
 * `pg.Client` directly to make the lifecycle explicit.
 */
export async function startSettingsListener(): Promise<SettingsListenerHandle> {
  const pool = getPool();
  const connectionString =
    (pool.options as { connectionString?: string }).connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set to start the settings LISTEN connection.");
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
          if (msg.channel !== LISTEN_CHANNELS.settingsChanged) return;
          void syncConfigFromSettingsRow().catch((err) => {
            logger.log("warn", "settings.listen.sync.error", {
              message: err instanceof Error ? err.message : String(err),
            });
          });
        });
        c.on("error", (err) => {
          logger.log("warn", "settings.listen.client.error", {
            message: err instanceof Error ? err.message : String(err),
          });
        });
        await c.query(`LISTEN ${LISTEN_CHANNELS.settingsChanged}`);
        logger.log("info", "settings.listen.ready", {
          channel: LISTEN_CHANNELS.settingsChanged,
        });
        await runSettingsBootScan();
        delay = 1_000;
        await new Promise<void>((resolve) => c.once("end", resolve));
      } catch (err) {
        logger.log("warn", "settings.listen.connect.error", {
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
          await activeClient.query(`UNLISTEN ${LISTEN_CHANNELS.settingsChanged}`);
        } catch {
          // best-effort
        }
        await activeClient.end().catch(() => {});
      }
    },
  };
}
