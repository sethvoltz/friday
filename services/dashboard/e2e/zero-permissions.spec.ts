/**
 * FRI-129 — AC #1: seeded rows materialize in the browser Zero client
 * once the sync-harness deploys Zero permissions.
 *
 * Zero 1.5 defaults every table to deny-all when no permissions row is
 * deployed. Before FRI-129 the test harness booted zero-cache but never
 * ran `zero-deploy-permissions`, so a seeded `agents` row replicated to
 * Postgres yet the browser client's `agents` Zero query
 * (`services/dashboard/src/lib/stores/zero.svelte.ts:580`) returned zero
 * rows. The harness now deploys permissions before spawning zero-cache,
 * mirroring production's supervisor `preStart`.
 *
 * This spec exercises the FULL chain — seed → deploy (done by the
 * harness in globalSetup) → zero-cache boot → query → row visible — not
 * the deploy step alone. It MUST fail on `main` (deny-all → 0 rows; the
 * row-wait times out) and pass after the fix.
 *
 * Why a Playwright spec and not a Node Zero client: Zero's Node client
 * closes WS with code 1006 against this harness (see the sync-harness
 * docstring). Chromium issues the real `agents` query through the
 * dashboard's own store; `window.__fridayZero` exposes the singleton so
 * the probe can read the materialized rows directly.
 *
 * Follows the `live-typing.spec.ts` cookie-injection + poll pattern.
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { envPath } from "./global-setup";

interface EnvSnapshot {
  dashboardURL: string;
  databaseUrl: string;
  cookie: string;
  userId: string;
  deviceId: string;
}

function loadEnv(): EnvSnapshot {
  return JSON.parse(readFileSync(envPath(), "utf8")) as EnvSnapshot;
}

/**
 * Translate the harness's `Cookie:` header string into Playwright's
 * `addCookies(...)` array shape. Identical to live-typing.spec.ts —
 * adapter-node binds HTTP locally, so `secure: false` is required for
 * Playwright to accept the cookie on a http:// origin.
 */
function parseCookiesForPlaywright(
  cookieHeader: string,
  url: string,
): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
}> {
  const u = new URL(url);
  return cookieHeader.split("; ").map((pair) => {
    const eq = pair.indexOf("=");
    return {
      name: pair.slice(0, eq),
      value: pair.slice(eq + 1),
      domain: u.hostname,
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax" as const,
    };
  });
}

/**
 * Seed a single `agents` row directly into the scratch upstream DB.
 * Mirrors the column set the dashboard's `agents` query reads
 * (`ZeroAgentRow` in zero.svelte.ts). `type`/`status` must satisfy the
 * schema's CHECK constraints (`bare`/`idle` are valid members).
 */
async function seedAgent(databaseUrl: string, name: string): Promise<void> {
  const c = new Client({ connectionString: databaseUrl });
  // Swallow late socket FATALs (57P01 from the harness's teardown
  // pg_terminate_backend) that can arrive after end() while the TCP
  // socket is still closing. Without an error listener Node turns that
  // into an unhandled exception and aborts the process. Mirrors the
  // shared `newTestClient` guard; `@friday/shared`'s test-pg factory
  // isn't imported into the Playwright tier, so inline the same no-op.
  c.on("error", () => {});
  await c.connect();
  try {
    await c.query(
      `INSERT INTO agents (name, type, status, session_count, created_at, updated_at)
         VALUES ($1, 'bare', 'idle', 0, now(), now())
       ON CONFLICT (name) DO NOTHING`,
      [name],
    );
  } finally {
    await c.end();
  }
}

test.describe("FRI-129: Zero permissions deployed → seeded rows materialize in browser", () => {
  test("seeded `perms-probe` agent appears in the browser's agents Zero query", async ({
    browser,
  }) => {
    const env = loadEnv();

    // Seed BEFORE the browser opens the WS subscription so the row is
    // already in the upstream replication stream when zero-cache serves
    // the initial CVR snapshot.
    await seedAgent(env.databaseUrl, "perms-probe");

    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(env.dashboardURL, { waitUntil: "domcontentloaded" });

    // Auth gate must accept the cookie (no redirect to /login).
    await expect(page).not.toHaveURL(/\/login/);

    // Mounting the chat page mounts the Sidebar, whose import side-effect
    // opens the `agents` Zero subscription (zero.svelte.ts:580). The
    // store singleton is exposed on `window.__fridayZero`; poll its
    // reactive `agents` array until the seeded row replicates through.
    const probe = await page.waitForFunction(
      () => {
        const z = (
          globalThis as unknown as {
            __fridayZero?: { agents?: Array<{ name: string }> };
          }
        ).__fridayZero;
        const row = z?.agents?.find((a) => a.name === "perms-probe");
        return row ? { name: row.name } : null;
      },
      undefined,
      { timeout: 25_000 },
    );

    const materialized = (await probe.jsonValue()) as { name: string };
    // EXACT field match — proves the deployed permissions let the seeded
    // row through, not merely that some agents query resolved.
    expect(materialized).toMatchObject({ name: "perms-probe" });
    expect(materialized.name).toBe("perms-probe");

    const realErrors = consoleErrors.filter((e) => !e.startsWith("Failed to load resource:"));
    expect(realErrors, `Unexpected JS errors: ${realErrors.join("\n")}`).toEqual([]);

    await context.close();
  });
});
