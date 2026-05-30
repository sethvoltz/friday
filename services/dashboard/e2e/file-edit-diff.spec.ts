/**
 * FRI-134 — file-edit diff promotion + coverage, browser-driven.
 *
 * The dashboard's unit pool runs in node with no jsdom, so the visual
 * promotion (diff shown directly, single cap + one expand control, K
 * MultiEdit hunks, NotebookEdit source view) can only be asserted in a
 * real Chromium. The pure input→props mapping is unit-tested separately
 * in `file-edit-input.test.ts`; the dispatch registration in
 * `tool-renderers.test.ts`.
 *
 * AC coverage:
 *   #1 — Edit diff body (≥1 .diff-added + ≥1 .diff-removed) is visible
 *        WITHOUT any tool-card expand click (no .tool-head precedes it).
 *   #3 — exactly ONE aria-expanded control in the file-edit subtree;
 *        clicking it flips true↔false; exactly ONE scrollable diff region
 *        (overflow-y:auto + a real max-height clamp).
 *   #4 — a 3-edit MultiEdit renders exactly 3 distinct diff hunk groups.
 *   #5 — NotebookEdit replace renders new_source as a content view
 *        (.block-pre, NOT a two-sided .diff-side-by-side); a delete
 *        variant renders a "cell deleted" notice instead of a code body.
 *   #6 — exactly ONE CollapsibleSection (.collapsible) + ONE scroll
 *        container in the rendered file-edit subtree (single-cap default).
 *
 * Seeds canonical `blocks` rows directly into the scratch upstream DB
 * (mirrors zero-permissions.spec.ts), then focuses the default `friday`
 * agent whose session_id matches the seeded rows. Zero replicates the
 * rows to the browser client and the chat renders them on load.
 */

import { test, expect, type Page } from "@playwright/test";
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

function parseCookiesForPlaywright(cookieHeader: string, url: string) {
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

interface SeedBlock {
  blockId: string;
  toolName: string;
  input: unknown;
  blockIndex: number;
}

/**
 * Upsert the default `friday` agent pinned to a known session, then insert
 * a tool_use block per descriptor for that session. Canonical tool_use rows
 * carry `{ name, input, tool_use_id }` in content_json — the exact shape the
 * dashboard's reload path (`parseBlockContent`) reads to build a
 * `role === "tool"` message. Each seed uses a unique agent + session so the
 * tests don't cross-contaminate.
 */
async function seedToolBlocks(
  databaseUrl: string,
  agentName: string,
  sessionId: string,
  blocks: SeedBlock[],
): Promise<void> {
  const c = new Client({ connectionString: databaseUrl });
  c.on("error", () => {});
  await c.connect();
  try {
    await c.query(
      `INSERT INTO agents (name, type, status, session_id, session_count, created_at, updated_at)
         VALUES ($1, 'bare', 'idle', $2, 1, now(), now())
       ON CONFLICT (name) DO UPDATE SET session_id = EXCLUDED.session_id, updated_at = now()`,
      [agentName, sessionId],
    );
    const turnId = `turn_${sessionId}`;
    for (const b of blocks) {
      const content = JSON.stringify({
        name: b.toolName,
        input: b.input,
        tool_use_id: b.blockId,
      });
      await c.query(
        `INSERT INTO blocks
           (id, block_id, turn_id, agent_name, session_id, message_id, block_index,
            role, kind, source, content_json, status, streaming, ts)
         VALUES ($1, $1, $2, $3, $4, $5, $6,
            'assistant', 'tool_use', 'sdk', $7::jsonb, 'complete', false, now())
         ON CONFLICT (block_id) DO NOTHING`,
        [b.blockId, turnId, agentName, sessionId, b.blockId, b.blockIndex, content],
      );
    }
  } finally {
    await c.end();
  }
}

/** Open the dashboard authenticated; `friday` is the default focused agent. */
async function openFridayChat(page: Page, env: EnvSnapshot): Promise<void> {
  await page.context().addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
  await page.goto(env.dashboardURL, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/login/);
  // Chat input hydrated → store is live → Zero subscription open.
  await expect(page.getByPlaceholder(/Message Friday/)).toBeVisible({ timeout: 15_000 });
}

test.describe("FRI-134: file-edit diff promotion", () => {
  test("AC#1/#3/#6 — Edit diff shows directly with exactly one cap + one expand control", async ({
    browser,
  }) => {
    const env = loadEnv();
    const session = `s_edit_${Date.now()}`;
    await seedToolBlocks(env.databaseUrl, "friday", session, [
      {
        blockId: `te_${Date.now()}`,
        toolName: "Edit",
        // Multi-line old/new so the diff is comfortably taller than nothing
        // and the side-by-side renders real added + removed rows.
        input: {
          file_path: "/tmp/fri134/sample.ts",
          old_string: "const a = 1;\nconst b = 2;\nconst c = 3;",
          new_string: "const a = 1;\nconst b = 22;\nconst c = 3;\nconst d = 4;",
        },
        blockIndex: 0,
      },
    ]);

    const context = await browser.newContext();
    const page = await context.newPage();
    await openFridayChat(page, env);

    // The file-edit renderer mounts FileDiff directly. Scope to it.
    const fileDiff = page.locator(".file-diff").first();
    await expect(fileDiff).toBeVisible({ timeout: 20_000 });

    // AC#1: diff body visible WITHOUT any tool-card expand. The promoted
    // renderer is FileEditRenderer (no .tool-head), so a .tool-head must NOT
    // wrap this diff. ToolBlock (the buried path) is what owns .tool-head.
    await expect(page.locator(".tool-head")).toHaveCount(0);
    await expect(fileDiff.locator(".diff-row.diff-added").first()).toBeVisible();
    await expect(fileDiff.locator(".diff-row.diff-removed").first()).toBeVisible();

    // AC#3/#6: exactly ONE aria-expanded control + ONE CollapsibleSection +
    // ONE scrollable region in the rendered subtree (single-cap default).
    const toggles = fileDiff.locator("[aria-expanded]");
    await expect(toggles).toHaveCount(1);
    await expect(fileDiff.locator(".collapsible")).toHaveCount(1);

    // Exactly one element with overflow-y:auto AND a real max-height clamp.
    // FileDiff renders collapsed-but-startOpen=true, so max-height is "none"
    // when open; flip closed to assert the clamp, then back open.
    const toggle = toggles.first();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    const scrollRegions = await fileDiff.evaluate((root) => {
      const all = Array.from(root.querySelectorAll<HTMLElement>("*"));
      return all.filter((el) => {
        const cs = getComputedStyle(el);
        return cs.overflowY === "auto" && cs.maxHeight !== "none" && cs.maxHeight !== "";
      }).length;
    });
    expect(scrollRegions).toBe(1);

    // Toggle flips back true.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    await context.close();
  });

  test("AC#4 — a 3-edit MultiEdit renders exactly 3 diff hunk groups", async ({ browser }) => {
    const env = loadEnv();
    const session = `s_multi_${Date.now()}`;
    await seedToolBlocks(env.databaseUrl, "friday", session, [
      {
        blockId: `tm_${Date.now()}`,
        toolName: "MultiEdit",
        input: {
          file_path: "/tmp/fri134/multi.ts",
          edits: [
            { old_string: "alpha", new_string: "ALPHA" },
            { old_string: "beta", new_string: "BETA" },
            { old_string: "gamma", new_string: "GAMMA" },
          ],
        },
        blockIndex: 0,
      },
    ]);

    const context = await browser.newContext();
    const page = await context.newPage();
    await openFridayChat(page, env);

    const fileDiff = page.locator(".file-diff").first();
    await expect(fileDiff).toBeVisible({ timeout: 20_000 });

    // Exactly 3 hunk groups (one .diff-hunk per edit).
    await expect(fileDiff.locator(".diff-hunk")).toHaveCount(3);
    // Still exactly one cap shared across all 3 hunks (no per-hunk scroller).
    await expect(fileDiff.locator(".collapsible")).toHaveCount(1);
    await expect(fileDiff.locator("[aria-expanded]")).toHaveCount(1);

    await context.close();
  });

  test("AC#5 — NotebookEdit replace shows a source view, delete shows a notice", async ({
    browser,
  }) => {
    const env = loadEnv();
    const session = `s_nb_${Date.now()}`;
    await seedToolBlocks(env.databaseUrl, "friday", session, [
      {
        blockId: `tnb_replace_${Date.now()}`,
        toolName: "NotebookEdit",
        input: {
          notebook_path: "/tmp/fri134/analysis.ipynb",
          new_source: "print('hello from a notebook cell')",
          cell_type: "code",
          edit_mode: "replace",
        },
        blockIndex: 0,
      },
      {
        blockId: `tnb_delete_${Date.now()}`,
        toolName: "NotebookEdit",
        input: {
          notebook_path: "/tmp/fri134/analysis.ipynb",
          cell_id: "abc",
          edit_mode: "delete",
        },
        blockIndex: 1,
      },
    ]);

    const context = await browser.newContext();
    const page = await context.newPage();
    await openFridayChat(page, env);

    const diffs = page.locator(".file-diff");
    await expect(diffs).toHaveCount(2, { timeout: 20_000 });

    // replace → content view: a .block-pre (code block), NOT a two-sided diff.
    const replaceDiff = diffs.nth(0);
    await expect(replaceDiff.locator(".block-pre")).toHaveCount(1);
    await expect(replaceDiff.locator(".diff-side-by-side")).toHaveCount(0);

    // delete → "cell deleted" notice, no code body.
    const deleteDiff = diffs.nth(1);
    await expect(deleteDiff.locator(".cell-deleted")).toHaveCount(1);
    await expect(deleteDiff.locator(".block-pre")).toHaveCount(0);

    await context.close();
  });
});
