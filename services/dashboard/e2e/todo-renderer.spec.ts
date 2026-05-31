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
 * Session match is load-bearing: the chat view binds the Zero `blocks`
 * slice by `agent_name` alone (zero.svelte.ts `bindBlocksFor`), then
 * `filterRowsToCurrentSession` (chat.svelte.ts) drops every row whose
 * `session_id` differs from the focused agent's `agents.session_id`. So
 * `seedTodoBlock` pins the block's `session_id` to the same value it writes
 * onto the `friday` agent's `session_id` (and UPSERTs that agent row with
 * DO UPDATE). Seeding a block on a session the agent isn't on renders
 * nothing — the row replicates fine but the client filters it out, which is
 * what made the first cut of this spec time out at 0 rows.
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

async function seedTodoBlock(
  databaseUrl: string,
  todos: Array<{ content: string; activeForm: string; status: string }> = TODOS,
): Promise<void> {
  const c = newTestClient({ connectionString: databaseUrl });
  await c.connect();
  try {
    const now = new Date();
    const blockId = `fri133-todo-${Date.now()}`;
    // The block's session MUST equal the focused agent's current
    // `agents.session_id`: the chat view binds the Zero `blocks` slice by
    // `agent_name` only, then `filterRowsToCurrentSession` (chat.svelte.ts)
    // drops every row whose `session_id !== agents.session_id`. A block on a
    // session the agent isn't currently on renders NOTHING — which is why the
    // first cut of this spec (random per-block session, agent session left
    // NULL) timed out at 0 rows even with healthy Zero sync. So we pin both to
    // the same id and UPSERT the agent's `session_id` (DO UPDATE, not DO
    // NOTHING — a pre-existing `friday` row from another suite would otherwise
    // keep its own/NULL session and re-orphan the block).
    const sessionId = `sess-${blockId}`;
    await c.query(
      `INSERT INTO agents (name, type, status, session_id, created_at, updated_at)
         VALUES ('friday', 'orchestrator', 'idle', $2, $1, $1)
         ON CONFLICT (name) DO UPDATE SET session_id = $2, updated_at = $1`,
      [now, sessionId],
    );
    const content = {
      name: "TodoWrite",
      input: { todos },
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
      [blockId, `turn-${blockId}`, sessionId, JSON.stringify(content), now],
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

    // FRI-137 (AC6 — no toggle-regression): the 5-row fixture fits within the
    // 320px cap, so the CollapsibleSection renders NO interactive disclosure
    // control — zero `[aria-expanded]` buttons in the todo block. (Pre-FRI-137
    // the toggle was always present; the smart-toggle change removes the
    // useless affordance when content fits.)
    await expect(page.locator(".todo-block [aria-expanded]")).toHaveCount(0);
    await expect(page.locator(".todo-block button.collapsible-toggle")).toHaveCount(0);
    // And, as always, NO chevron/triangle glyph appears.
    const blockText = (await page.locator(".todo-block").first().textContent()) ?? "";
    expect(blockText).not.toMatch(/[▸▾▴►◄‣⌄⌃]/);

    await context.close();
  });

  test("FRI-137 AC6 — a long todo list keeps a working +/- toggle in its header", async ({
    browser,
  }) => {
    const env = loadEnv();
    // ~40 rows comfortably exceeds the 320px cap → the toggle must appear.
    const many = Array.from({ length: 40 }, (_, i) => ({
      content: `Task number ${i}`,
      activeForm: `Doing task number ${i}`,
      status: i === 0 ? "in_progress" : "pending",
    }));
    await seedTodoBlock(env.databaseUrl, many);

    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();
    await page.goto(env.dashboardURL, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/login/);

    await expect(page.locator("[data-todo-status]")).toHaveCount(40, { timeout: 20_000 });

    // Overflowing list → exactly one interactive disclosure control carrying
    // the +/− glyph + aria-expanded, and it toggles on click.
    const toggle = page.locator(".todo-block button.collapsible-toggle").first();
    await expect(toggle).toHaveAttribute("aria-expanded", /true|false/);
    const glyph = (await toggle.locator(".glyph").textContent())?.trim();
    expect(["+", "−"]).toContain(glyph);
    const before = await toggle.getAttribute("aria-expanded");
    await toggle.click();
    await expect(toggle).not.toHaveAttribute("aria-expanded", before ?? "");

    await context.close();
  });
});
