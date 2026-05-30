/**
 * FRI-133 — visual round-trip for the purpose-built TodoWrite renderer
 * (ACs #7, #8-DOM, #9).
 *
 * The dashboard's node/forks unit pool has no DOM, so the renderer's
 * pure logic is pinned in `todo-render.test.ts`; this spec pins the
 * actual rendered output in a real Chromium against the full sync env.
 *
 * Approach: the unit suite can't mount a Svelte component (no
 * @testing-library/svelte, node env), so we stand a TodoWrite tool block
 * up the canonical way — insert an `agents` row for `friday` and a
 * `kind='tool_use'` `blocks` row whose `content_json` is
 * `{ name: "TodoWrite", input: { todos: [...] }, tool_use_id }`,
 * `streaming=false` / `status='complete'` so zero-cache replicates it
 * (Zero's publication is scoped to `WHERE streaming=false`). The browser's
 * Zero client syncs the row, `parseBlocks` maps it to a `role:"tool"`
 * message, and `ChatMessages` routes it through `resolveToolRenderer`
 * ("TodoWrite" hits step 1 on its literal key) → the TodoList renderer.
 *
 * Asserts:
 *   - N items → N rows: the 5-item fixture renders exactly 5
 *     `[data-todo-status]` rows (3 one-per-status + 2 blank-field);
 *   - rows appear in input order (the leading three are the sequence
 *     ["pending","in_progress","completed"]);
 *   - the completed row's label has computed `text-decoration: line-through`;
 *   - the in_progress row shows its `activeForm` text and NOT its `content`;
 *   - blank-row fallback: an in_progress row with empty content shows
 *     activeForm, a pending row with empty activeForm shows content (AC#8);
 *   - the generic ToolBlock JSON `<pre>` is absent (TodoWrite no longer
 *     reaches ToolBlock);
 *   - the CollapsibleSection wrapper carries the +/− glyph + aria-expanded
 *     and renders no chevron/triangle (AC#9 DOM half; the static-source
 *     grep half is in this file's sibling assertions / the component).
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { newTestClient } from "@friday/shared/test/sync-harness";
import { envPath } from "./global-setup";

interface EnvSnapshot {
  dashboardURL: string;
  databaseUrl: string;
  cookie: string;
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

// The five fixture rows: one per status for the order/count/strike asserts,
// plus the two blank-field rows for the AC#8 fallback assert. activeForm and
// content differ per row so we can assert WHICH field rendered.
const TODOS = [
  { content: "Write the parser", activeForm: "Writing the parser", status: "pending" },
  { content: "Run the suite", activeForm: "Running the suite", status: "in_progress" },
  { content: "Ship the PR", activeForm: "Shipping the PR", status: "completed" },
  // blank-field fallback rows (AC#8):
  { content: "", activeForm: "Doing it", status: "in_progress" },
  { content: "Do it", activeForm: "", status: "pending" },
];

async function seedTodoBlock(databaseUrl: string): Promise<void> {
  const c = newTestClient({ connectionString: databaseUrl });
  await c.connect();
  try {
    const now = new Date();
    // Idempotent agent row — `friday` is the default focused agent.
    await c.query(
      `INSERT INTO agents (name, type, status, created_at, updated_at)
         VALUES ('friday', 'orchestrator', 'idle', $1, $1)
         ON CONFLICT (name) DO NOTHING`,
      [now],
    );
    const blockId = `fri133-todo-${Date.now()}`;
    const content = {
      name: "TodoWrite",
      input: { todos: TODOS },
      tool_use_id: `tu_${blockId}`,
    };
    // Canonical tool_use block: streaming=false + status='complete' so the
    // Zero publication (WHERE streaming=false) replicates it to the browser.
    await c.query(
      `INSERT INTO blocks
         (id, block_id, turn_id, agent_name, session_id, block_index,
          role, kind, source, content_json, status, streaming, ts)
       VALUES
         ($1, $1, $2, 'friday', $3, 0,
          'assistant', 'tool_use', 'sdk', $4, 'complete', false, $5)`,
      [blockId, `turn-${blockId}`, `sess-${blockId}`, JSON.stringify(content), now],
    );
  } finally {
    await c.end();
  }
}

test.describe("FRI-133 — TodoWrite renderer (visual)", () => {
  test("renders the task list directly: rows, order, strike-through, activeForm, fallback, no JSON", async ({
    browser,
  }) => {
    const env = loadEnv();
    await seedTodoBlock(env.databaseUrl);

    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();
    await page.goto(env.dashboardURL, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/login/);

    // The TodoWrite rows render once the Zero client syncs the block.
    const rows = page.locator("[data-todo-status]");
    await expect(rows).toHaveCount(5, { timeout: 20_000 });

    // Row order matches the fixture array order.
    await expect(rows.nth(0)).toHaveAttribute("data-todo-status", "pending");
    await expect(rows.nth(1)).toHaveAttribute("data-todo-status", "in_progress");
    await expect(rows.nth(2)).toHaveAttribute("data-todo-status", "completed");
    await expect(rows.nth(3)).toHaveAttribute("data-todo-status", "in_progress");
    await expect(rows.nth(4)).toHaveAttribute("data-todo-status", "pending");

    // Completed row: label is struck through.
    const completedLabel = rows.nth(2).locator(".todo-label");
    await expect(completedLabel).toHaveText("Ship the PR");
    const decoration = await completedLabel.evaluate((el) => getComputedStyle(el).textDecoration);
    expect(decoration).toContain("line-through");

    // In-progress row shows its activeForm, NOT its content.
    const inProgressLabel = rows.nth(1).locator(".todo-label");
    await expect(inProgressLabel).toHaveText("Running the suite");
    await expect(inProgressLabel).not.toHaveText("Run the suite");

    // Pending row shows its content (imperative).
    await expect(rows.nth(0).locator(".todo-label")).toHaveText("Write the parser");

    // Blank-field fallback (AC#8): in_progress with empty content → activeForm;
    // pending with empty activeForm → content. Neither label is empty.
    await expect(rows.nth(3).locator(".todo-label")).toHaveText("Doing it");
    await expect(rows.nth(4).locator(".todo-label")).toHaveText("Do it");

    // The generic ToolBlock JSON view is NOT used for TodoWrite: no raw
    // JSON `<pre>` containing the todos array text.
    await expect(page.locator("pre", { hasText: "activeForm" })).toHaveCount(0);

    // AC#9: the CollapsibleSection wrapper carries the +/− disclosure glyph
    // and aria-expanded; no chevron/triangle glyph appears in the rendered
    // todo block.
    const toggle = page.locator(".todo-block button.collapsible-toggle").first();
    await expect(toggle).toHaveAttribute("aria-expanded", /true|false/);
    const glyph = await toggle.locator(".glyph").textContent();
    expect(["+", "−"]).toContain(glyph?.trim());
    const blockText = (await page.locator(".todo-block").first().textContent()) ?? "";
    expect(blockText).not.toMatch(/[▸▾▴►◄‣⌄⌃]/);

    await context.close();
  });
});
