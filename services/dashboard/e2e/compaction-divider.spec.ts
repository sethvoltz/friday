/**
 * FRI-156 §E/§F — visual round-trip for the durable compaction divider and
 * the "Viewing pre-compaction history" pill.
 *
 * The dashboard's node/forks unit pool has no DOM, so the divider/pill pure
 * logic is pinned in `chat.test.ts` + `compaction-render.test.ts`; this spec
 * pins the actual rendered output in a real Chromium against the full sync
 * env (mirrors `todo-renderer.spec.ts`).
 *
 * Approach: stand the divider up the canonical way — UPSERT the `friday`
 * agent's `session_id`, then INSERT a `kind='compaction'` `blocks` row whose
 * `content_json` is `{ pre_tokens, post_tokens, duration_ms }`,
 * `streaming=false` / `status='complete'` so zero-cache replicates it (Zero's
 * publication is scoped to `WHERE streaming=false`). To make the pill testable
 * we seed a run of assistant text blocks ABOVE the divider (so the divider is
 * not at the very top) and one user block BELOW it (so "scroll to top" puts the
 * divider below the viewport). The browser's Zero client syncs the rows,
 * `parseBlocks` maps the compaction row to a `kind:"compaction"` divider, and
 * `ChatMessages` renders `.compaction-divider`.
 *
 * Session match is load-bearing (same reason as todo-renderer.spec.ts): the
 * chat view binds the Zero `blocks` slice by `agent_name` alone, then
 * `filterRowsToCurrentSession` drops every row whose `session_id` differs from
 * the focused agent's `agents.session_id`. So every seeded block pins its
 * `session_id` to the value written onto the `friday` agent row.
 *
 * Asserts:
 *   - the full-width `.compaction-divider` renders with the humanized copy
 *     "Context compacted · 779.0K → 50.00K tokens";
 *   - the "Viewing pre-compaction history" pill is hidden when the divider is
 *     in view (initial load pins to the latest, divider visible);
 *   - scrolling to the top of the transcript (divider below the viewport)
 *     shows the pill, and clicking it scrolls the divider back into view.
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

const PRE_TOKENS = 779_000;
const POST_TOKENS = 50_000;
const DIVIDER_COPY = "Context compacted · 779.0K → 50.00K tokens";

/**
 * Seed: ~30 assistant text blocks (so the transcript scrolls), then a
 * compaction marker block, then a trailing user block — all on one session
 * pinned to the friday agent. Returns the seeded session id + divider block id.
 */
async function seedCompactionTranscript(databaseUrl: string): Promise<{ dividerBlockId: string }> {
  const c = newTestClient({ connectionString: databaseUrl });
  await c.connect();
  try {
    const base = Date.now();
    const stamp = `fri156-${base}`;
    const sessionId = `sess-${stamp}`;
    const now = new Date(base);

    await c.query(
      `INSERT INTO agents (name, type, status, session_id, created_at, updated_at)
         VALUES ('friday', 'orchestrator', 'idle', $2, $1, $1)
         ON CONFLICT (name) DO UPDATE SET session_id = $2, updated_at = $1`,
      [now, sessionId],
    );

    // ~30 assistant text bubbles above the divider so the chat actually
    // scrolls (WINDOW_SIZE is 100, so this stays in one window).
    for (let i = 0; i < 30; i++) {
      const id = `${stamp}-pre-${i}`;
      await c.query(
        `INSERT INTO blocks
           (id, block_id, turn_id, agent_name, session_id, block_index,
            role, kind, source, content_json, status, streaming, ts)
         VALUES
           ($1, $1, $2, 'friday', $3, 0,
            'assistant', 'text', 'sdk', $4, 'complete', false, $5)`,
        [
          id,
          `turn-pre-${i}-${stamp}`,
          sessionId,
          JSON.stringify({ text: `pre-compaction message number ${i}` }),
          new Date(base + i),
        ],
      );
    }

    // The durable compaction marker block. Shape mirrors exactly what the
    // daemon's recordCompactionMarker writes (block-injectors.ts): role
    // 'system', kind 'compaction', source NULL, block_index 9999 (the
    // post-finalize fallback). The render path keys only on kind + content_json,
    // but seeding the daemon-faithful row keeps this visual round-trip honest
    // rather than validating a hand-shaped row the daemon never produces.
    const dividerBlockId = `${stamp}-divider`;
    await c.query(
      `INSERT INTO blocks
         (id, block_id, turn_id, agent_name, session_id, block_index,
          role, kind, source, content_json, status, streaming, ts)
       VALUES
         ($1, $1, $2, 'friday', $3, 9999,
          'system', 'compaction', NULL, $4, 'complete', false, $5)`,
      [
        dividerBlockId,
        `turn-divider-${stamp}`,
        sessionId,
        JSON.stringify({ pre_tokens: PRE_TOKENS, post_tokens: POST_TOKENS, duration_ms: 4200 }),
        new Date(base + 100),
      ],
    );

    // One trailing user block BELOW the divider so the divider is not the last
    // row — pinning to latest keeps the divider on-screen, scrolling to top
    // puts it below the viewport.
    const tailId = `${stamp}-post`;
    await c.query(
      `INSERT INTO blocks
         (id, block_id, turn_id, agent_name, session_id, block_index,
          role, kind, source, content_json, status, streaming, ts)
       VALUES
         ($1, $1, $2, 'friday', $3, 0,
          'user', 'text', 'user_chat', $4, 'complete', false, $5)`,
      [
        tailId,
        `turn-post-${stamp}`,
        sessionId,
        JSON.stringify({ text: "after the compaction" }),
        new Date(base + 200),
      ],
    );

    return { dividerBlockId };
  } finally {
    await c.end();
  }
}

test.describe("FRI-156 — compaction divider + pre-compaction pill (visual)", () => {
  test("renders the full-width divider and the pill appears + scrolls on click", async ({
    browser,
  }) => {
    const env = loadEnv();
    const { dividerBlockId } = await seedCompactionTranscript(env.databaseUrl);

    const context = await browser.newContext({ viewport: { width: 1280, height: 700 } });
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();
    await page.goto(env.dashboardURL, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/login/);

    // The durable divider renders once the Zero client syncs the marker block.
    const divider = page.locator(".compaction-divider");
    await expect(divider).toHaveCount(1, { timeout: 20_000 });
    await expect(divider.locator(".compaction-divider-label")).toHaveText(DIVIDER_COPY);

    // The divider carries its stable data-msg-id (cb_<blockId>) so the pill's
    // scroll target resolves.
    await expect(divider).toHaveAttribute("data-msg-id", `cb_${dividerBlockId}`);

    // On initial load the chat pins to the latest message (below the divider),
    // so the divider is on-screen → the pill is hidden.
    const pill = page.locator("button.floating-pill.pre-compaction");
    await expect(pill).toHaveCount(0);

    // Scroll the transcript to the very top: the divider now sits below the
    // viewport → the "Viewing pre-compaction history" pill appears.
    // Scroll up with a real wheel gesture (not a programmatic scrollTop write,
    // which the post-resync bottom-chase loop immediately reverts). Real user
    // scroll input self-aborts that loop, mirroring how a person reaches
    // pre-compaction history. Hover the transcript first so the wheel targets it.
    const scroller = page.locator(".chat-scroll");
    await scroller.hover();
    await page.mouse.wheel(0, -4000);
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await expect(pill).toHaveText("Viewing pre-compaction history");

    // Clicking the pill scrolls the divider back into view; once it's visible
    // again the pill hides itself (the IntersectionObserver flips
    // viewingPreCompaction back to false).
    await pill.click();
    await expect(divider).toBeInViewport({ timeout: 10_000 });
    await expect(pill).toHaveCount(0, { timeout: 10_000 });

    await context.close();
  });
});
