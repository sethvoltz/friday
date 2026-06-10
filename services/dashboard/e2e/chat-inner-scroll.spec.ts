/**
 * Chat inner-scroller round-trip (ADR-041 — supersedes the FRI-160
 * document-scroll model for the chat route).
 *
 * The chat transcript is again a real INNER scroller (`.chat-transcript`,
 * `position:absolute; inset:0; overflow-y:auto`) inside a visual-viewport-
 * sized fixed column, with the body hard-locked (`html.chat-scroll-lock`)
 * so the document never scrolls on this route. The composer sits in the
 * column as a translucent overlay and never has to chase the keyboard
 * (the keyboard-up stutter that document scroll couldn't avoid is gone).
 * This spec pins the user-visible scroll behaviors against the full sync
 * env (mirrors `todo-renderer.spec.ts` / `compaction-divider.spec.ts`):
 *
 *   - AC6: navigating to `/` lands at the BOTTOM of the transcript, and
 *     the INNER SCROLLER holds the position (`.chat-transcript.scrollTop
 *     > 0`) while `window.scrollY === 0` proves the document/body is
 *     LOCKED — a regression back to document scroll would move
 *     window.scrollY and leave the body scrollable.
 *   - AC6b: chat (locked body, transcript scrolls) → Settings (normal
 *     document scroll, lands at top) → back into chat (transcript at
 *     bottom again). The two routes use different scrollers; this proves
 *     the body-lock is scoped to the chat route and released on leave.
 *   - AC7a: stick-to-bottom — while assistant blocks stream in, the
 *     `.bottom-sentinel` stays in the viewport and the transcript follows.
 *   - AC7b: anchor-restore — scrolling up across a virtualization window
 *     slide keeps the topmost visible `[data-msg-id]` in the viewport.
 *   - AC7c: the `button.floating-pill.jump-to-bottom` pill returns to the
 *     latest message (`.bottom-sentinel` back in viewport, pill unmounts).
 *   - AC7d: `/jump <term>` scrolls the matched `[data-msg-id]` into view,
 *     including a target OUTSIDE the rendered window (the jump must slide
 *     the window before scrollIntoView can land).
 *
 * Streaming caveat (AC7a): the harness runs no real Claude turn (no
 * ANTHROPIC_API_KEY — same boundary live-typing.spec.ts documents), so
 * token-level SSE deltas aren't reachable here. Instead we append complete
 * assistant blocks one at a time through the canonical Postgres → zero-cache
 * → Zero-client path, gating on each bubble's arrival before the next
 * insert. Each append grows the transcript while `pinnedToBottom` is true —
 * the exact follow path streaming deltas drive.
 *
 * Determinism: every wait is an auto-retrying web-first assertion
 * (`toBeInViewport()/.toBeVisible()/.toBeAttached()`, `expect.poll`,
 * `toPass`) on a converged state — NO sleeps on scroll state. The wheel
 * loops gate on `.chat-transcript.scrollTop` actually changing before the
 * next measurement, because `page.mouse.wheel` does not wait for the
 * resulting scroll to apply.
 *
 * Wheel delivery: the wheel lands on whatever is under the pointer, so we
 * hover the `.chat-transcript` scroller at its visible centre first.
 *
 * Session match is load-bearing (same as todo-renderer.spec.ts): the chat
 * view binds the Zero `blocks` slice by `agent_name`, then
 * `filterRowsToCurrentSession` drops rows whose `session_id` differs from
 * the focused agent's `agents.session_id` — so each test seeds a fresh
 * session and UPSERTs it onto the `friday` agent row, which also isolates
 * the tests from each other and from sibling spec files.
 */

import {
  test,
  expect,
  type Page,
  type Browser,
  type BrowserContext,
  type Locator,
} from "@playwright/test";
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

/**
 * `parseBlocks` keys an assistant text block's ChatMessage id as
 * `b_<blockId>` — that id is what `data-msg-id` carries in the DOM
 * (same contract the compaction spec relies on with `cb_<blockId>`).
 */
function domId(blockId: string): string {
  return `b_${blockId}`;
}

/**
 * Seed `count` complete assistant text bubbles on one fresh session pinned
 * to the `friday` agent (`streaming=false` / `status='complete'` so the
 * zero-cache publication replicates them). `textFor` lets a test plant a
 * unique needle for `/jump`. Returns the session id so a test can append
 * more blocks to the same transcript later.
 */
async function seedTranscript(
  databaseUrl: string,
  stamp: string,
  count: number,
  textFor: (i: number) => string = (i) => `filler bubble number ${i} — ${stamp}`,
): Promise<{ sessionId: string }> {
  const c = newTestClient({ connectionString: databaseUrl });
  await c.connect();
  try {
    const base = Date.now();
    const sessionId = `sess-${stamp}`;
    const now = new Date(base);

    await c.query(
      `INSERT INTO agents (name, type, status, session_id, created_at, updated_at)
         VALUES ('friday', 'orchestrator', 'idle', $2, $1, $1)
         ON CONFLICT (name) DO UPDATE SET session_id = $2, updated_at = $1`,
      [now, sessionId],
    );

    for (let i = 0; i < count; i++) {
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
          JSON.stringify({ text: textFor(i) }),
          new Date(base + i),
        ],
      );
    }
    return { sessionId };
  } finally {
    await c.end();
  }
}

/** Open an authenticated chat page at `/` and wait out the login gate. */
async function openChat(
  browser: Browser,
  env: EnvSnapshot,
  viewport: { width: number; height: number },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
  const page = await context.newPage();
  await page.goto(env.dashboardURL, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/login/);
  return { context, page };
}

/** Scroll position of the chat's INNER scroller (`.chat-transcript`). */
function readScroll(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector(".chat-transcript")?.scrollTop ?? 0);
}

/**
 * Sync gate: the NEWEST seeded bubble is rendered and inside the viewport.
 * Every test must pass through this before asserting any scroll behavior —
 * `.bottom-sentinel` alone is NOT a sync gate, because the sentinel is
 * rendered even for an empty list: before the Zero replica delivers the
 * seeded blocks, the transcript is empty, the page is short, and the
 * sentinel sits vacuously "in viewport" (this exact race produced a
 * 1.2-second false failure of the anchor test: the wheel loops no-opped
 * on a contentless page and no `[data-msg-id]` existed to anchor on).
 * The newest bubble in-viewport proves both that the seed replicated and
 * that entry landed at the bottom of a *real* transcript.
 */
async function awaitSeededTranscript(page: Page, stamp: string, count: number): Promise<void> {
  await expect(
    page.locator(`[data-msg-id="${domId(`${stamp}-pre-${count - 1}`)}"]`),
  ).toBeInViewport({ timeout: 20_000 });
}

/**
 * Park the pointer over the `.chat-transcript` inner scroller at the
 * centre of its visible box so subsequent `page.mouse.wheel` calls scroll
 * the transcript (not the locked document).
 */
async function hoverScroller(page: Page): Promise<void> {
  await page.locator(".chat-transcript").hover();
}

/**
 * Wheel upward in `step`px increments until the `.top-sentinel`'s bottom
 * edge rises above `threshold` (a negative viewport-relative px value).
 * Each iteration measures FIRST, then wheels, then gates on the
 * transcript's `scrollTop` having changed — so the next measurement never
 * reads a stale position and the loop cannot overshoot by more than one
 * `step`. Used to stop a controlled distance BEFORE the slide trigger (the
 * top sentinel's IntersectionObserver fires at rootMargin 600px, i.e. when
 * the sentinel's bottom rises above -600).
 */
async function wheelUntilTopSentinelAbove(
  page: Page,
  threshold: number,
  step: number,
  maxIters: number,
): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    const bottom = await page.evaluate(
      () =>
        document.querySelector(".top-sentinel")?.getBoundingClientRect().bottom ??
        Number.NEGATIVE_INFINITY,
    );
    if (bottom > threshold) return;
    const before = await readScroll(page);
    await page.mouse.wheel(0, -step);
    await expect.poll(() => readScroll(page), { timeout: 5_000 }).not.toBe(before);
  }
  throw new Error(
    `top sentinel never rose above ${threshold}px after ${maxIters} wheel steps of ${step}px`,
  );
}

test.describe("chat inner scroller (ADR-041)", () => {
  test("AC6 — navigation lands at the bottom; the INNER scroller holds it and the body is locked", async ({
    browser,
  }) => {
    const env = loadEnv();
    const stamp = `inner-nav-${Date.now()}`;
    await seedTranscript(env.databaseUrl, stamp, 160);

    const { context, page } = await openChat(browser, env, { width: 1280, height: 720 });

    // Entry parity: the chat route lands pinned to the latest message.
    // The seeded-transcript gate (not the sentinel) is what proves sync —
    // see awaitSeededTranscript.
    await awaitSeededTranscript(page, stamp, 160);
    await expect(page.locator(".bottom-sentinel")).toBeInViewport({ timeout: 20_000 });

    // The `.chat-transcript` inner scroller holds the position: a tall
    // transcript pinned to its bottom means its scrollTop is far from 0.
    await expect(page.locator(".chat-transcript")).toBeVisible();
    await expect.poll(() => readScroll(page)).toBeGreaterThan(0);
    // ...and the document/body is LOCKED — window.scrollY stays 0 and the
    // body is not scrollable. A regression back to document scroll would
    // break both invariants (and reopen the ADR-039 touch-routing fight).
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).overflow),
    ).toContain("hidden");

    await context.close();
  });

  test("AC6b — chat (locked body) → Settings (document scroll, top) → back into chat (bottom)", async ({
    browser,
  }) => {
    const env = loadEnv();
    const stamp = `inner-leave-${Date.now()}`;
    await seedTranscript(env.databaseUrl, stamp, 160);

    // Short viewport so the destination page (Settings) is taller than
    // the viewport — a too-short destination would clamp scrollY to 0 on
    // its own and mask a leak.
    const { context, page } = await openChat(browser, env, { width: 1280, height: 500 });
    await awaitSeededTranscript(page, stamp, 160);
    // Chat: the inner scroller is at the bottom and the body is locked.
    await expect.poll(() => readScroll(page)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    // Header-nav to Settings — a normal document-scrolling route. The
    // body-lock must be released (ChatShell unmount removes
    // .chat-scroll-lock) and the router lands Settings at the top.
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings/);
    // The lock is gone: the document is scrollable again.
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).overflow))
      .not.toContain("hidden");
    // Guard against vacuity: the destination must actually be scrollable,
    // otherwise scrollY=0 proves nothing.
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight))
      .toBe(true);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

    // And header-nav back INTO chat lands at the transcript bottom again
    // (the direct-load case is AC6; this is the in-app link case).
    await page.getByRole("link", { name: "Chat" }).click();
    await expect(page).toHaveURL(`${env.dashboardURL.replace(/\/$/, "")}/`);
    await expect(page.locator(".bottom-sentinel")).toBeInViewport({ timeout: 10_000 });
    await expect.poll(() => readScroll(page)).toBeGreaterThan(0);

    await context.close();
  });

  test("AC7a — stays pinned to the bottom while assistant blocks stream in", async ({
    browser,
  }) => {
    const env = loadEnv();
    const stamp = `inner-stick-${Date.now()}`;
    const { sessionId } = await seedTranscript(env.databaseUrl, stamp, 40);

    const { context, page } = await openChat(browser, env, { width: 1280, height: 720 });
    await awaitSeededTranscript(page, stamp, 40);
    await expect(page.locator(".bottom-sentinel")).toBeInViewport({ timeout: 20_000 });
    const yAtBottom = await readScroll(page);

    // Append 10 assistant blocks one at a time, gating on each bubble's
    // arrival in the DOM before inserting the next. The per-block cadence
    // mirrors streaming's small-increment growth (each step stays inside
    // the bottom sentinel's 200px rootMargin, so pinnedToBottom never
    // legitimately flips); the 10-block total (~600-800px) is decisively
    // taller than the viewport headroom, so a broken follow path CANNOT
    // pass the final in-viewport assertion below.
    const c = newTestClient({ connectionString: env.databaseUrl });
    await c.connect();
    try {
      const liveBase = Date.now();
      for (let i = 0; i < 10; i++) {
        const id = `${stamp}-live-${i}`;
        await c.query(
          `INSERT INTO blocks
             (id, block_id, turn_id, agent_name, session_id, block_index,
              role, kind, source, content_json, status, streaming, ts)
           VALUES
             ($1, $1, $2, 'friday', $3, 0,
              'assistant', 'text', 'sdk', $4, 'complete', false, $5)`,
          [
            id,
            `turn-live-${i}-${stamp}`,
            sessionId,
            JSON.stringify({
              text: `streamed follow chunk ${i} of 10 — ${id} — the transcript keeps growing under the pinned viewport.`,
            }),
            new Date(liveBase + i),
          ],
        );
        // toBeVisible (not in-viewport) on purpose: it proves the block
        // synced and mounted without presupposing the follow worked — the
        // follow itself is pinned once, decisively, after the loop.
        await expect(page.locator(`[data-msg-id="${domId(id)}"]`)).toBeVisible({
          timeout: 15_000,
        });
      }
    } finally {
      await c.end();
    }

    // Stick-to-bottom held: the sentinel is still in the viewport after
    // ~10 bubbles of growth, and the document scrolled DOWN to follow.
    await expect(page.locator(".bottom-sentinel")).toBeInViewport({ timeout: 10_000 });
    await expect.poll(() => readScroll(page)).toBeGreaterThan(yAtBottom);

    await context.close();
  });

  test("AC7b — scroll-up anchor keeps its identity in the viewport across a window slide", async ({
    browser,
  }) => {
    const env = loadEnv();
    const stamp = `inner-anchor-${Date.now()}`;
    // 160 messages: WINDOW_SIZE is 100, so the initial render mounts
    // indices 60..159 and a slide-up (SLIDE_AMOUNT 20) prepends 40..59.
    await seedTranscript(env.databaseUrl, stamp, 160);

    // Tall viewport: the captured anchor must survive the few hundred px
    // of additional wheel travel between capture and the slide trigger
    // without legitimately exiting the viewport bottom.
    const { context, page } = await openChat(browser, env, { width: 1280, height: 1100 });
    await awaitSeededTranscript(page, stamp, 160);

    await hoverScroller(page);
    // Approach the slide trigger in two gated phases: coarse to within
    // ~2.2k px of the top sentinel, then fine 200px steps to within
    // 1000px — comfortably short of the 600px rootMargin trigger, so the
    // anchor capture below provably happens BEFORE the slide.
    await wheelUntilTopSentinelAbove(page, -2_200, 600, 60);
    await wheelUntilTopSentinelAbove(page, -1_000, 200, 20);

    // Pick the slide marker: the first not-yet-mounted bubble from the
    // batches successive slide-ups prepend (40..59 → marker 50, then
    // 20..39 → 30, then 0..19 → 10). Tolerates a slide having already
    // fired during the approach — the test then pins the NEXT slide.
    let marker: Locator | null = null;
    for (const i of [50, 30, 10]) {
      const loc = page.locator(`[data-msg-id="${domId(`${stamp}-pre-${i}`)}"]`);
      if ((await loc.count()) === 0) {
        marker = loc;
        break;
      }
    }
    if (!marker)
      throw new Error("every slide marker is already mounted — window never virtualized");
    // Re-bind through a const so the narrowed type survives into the
    // retry closure below (TS can't carry a `let` narrowing across it).
    const slideMarker = marker;

    // Capture the topmost visible bubble (below the fixed header band,
    // solidly inside the viewport) — the element whose viewport position
    // the slide's anchor-restore must preserve.
    const anchorId = await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll("[data-msg-id]"))) {
        const r = el.getBoundingClientRect();
        if (r.bottom > 130 && r.top < window.innerHeight - 60) {
          return el.getAttribute("data-msg-id");
        }
      }
      return null;
    });
    expect(anchorId, "a visible [data-msg-id] anchor must exist before the slide").not.toBeNull();

    // Cross the 600px rootMargin: small gated wheels until the marker
    // batch mounts. `toPass` re-wheels on each retry, so the loop
    // converges without any fixed sleep; the inner 1s window gives the
    // IntersectionObserver → slideWindow → mount chain time to land.
    await expect(async () => {
      await page.mouse.wheel(0, -200);
      await expect(slideMarker).toBeAttached({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });

    // The slide prepended ~20 bubbles ABOVE the anchor. With anchor-
    // restore working, the document scroll position was compensated and
    // the captured element keeps its place; if restore broke, the new
    // content shoves it a full batch-height (~1200px+) out of the
    // viewport and this assertion fails.
    await expect(page.locator(`[data-msg-id="${anchorId}"]`)).toBeInViewport();

    await context.close();
  });

  test("AC7c — jump-to-bottom pill returns to the latest message", async ({ browser }) => {
    const env = loadEnv();
    const stamp = `inner-jumpbtn-${Date.now()}`;
    await seedTranscript(env.databaseUrl, stamp, 60);

    const { context, page } = await openChat(browser, env, { width: 1280, height: 720 });
    await awaitSeededTranscript(page, stamp, 60);
    await expect.poll(() => readScroll(page)).toBeGreaterThan(0);
    const yAtBottom = await readScroll(page);

    // Wheel up past the bottom sentinel's 200px headroom: pinnedToBottom
    // flips false and the pill mounts. The pill's visibility is the
    // converged-state gate for the wheel having scrolled.
    await hoverScroller(page);
    await page.mouse.wheel(0, -1_600);
    const pill = page.locator("button.floating-pill.jump-to-bottom");
    await expect(pill).toBeVisible({ timeout: 10_000 });
    // ...and it was the DOCUMENT that scrolled up, not a nested element.
    await expect.poll(() => readScroll(page)).toBeLessThan(yAtBottom);

    // Click → back at the latest message; the IntersectionObserver flips
    // pinnedToBottom true again and the pill unmounts itself.
    await pill.click();
    await expect(page.locator(".bottom-sentinel")).toBeInViewport({ timeout: 10_000 });
    await expect(pill).toHaveCount(0, { timeout: 10_000 });

    await context.close();
  });

  test("AC7d — /jump scrolls the matched message into view", async ({ browser }) => {
    const env = loadEnv();
    const stamp = `inner-slash-${Date.now()}`;
    const needle = `needle-${stamp}`;
    // Plant the needle at index 5 — OUTSIDE the initial 100-message render
    // window (which starts at index 60), so the jump must slide the
    // virtualization window before scrollIntoView can land on the target.
    await seedTranscript(env.databaseUrl, stamp, 160, (i) =>
      i === 5
        ? `the hidden ${needle} lives in this bubble`
        : `filler bubble number ${i} — ${stamp}`,
    );

    const { context, page } = await openChat(browser, env, { width: 1280, height: 720 });
    await awaitSeededTranscript(page, stamp, 160);

    // Guard: the target is not even mounted before the jump (it sits
    // below the rendered window's start) — proves the jump did the work.
    // Meaningful only AFTER the seeded gate above: on a not-yet-synced
    // empty transcript this would pass vacuously.
    const target = page.locator(`[data-msg-id="${domId(`${stamp}-pre-5`)}"]`);
    await expect(target).toHaveCount(0);

    // Issue the jump through the chat input, same path live-typing uses:
    // fill + the aria-labelled Send button (slash parsing happens at send;
    // /jump is purely client-side, no daemon round-trip).
    const input = page.getByPlaceholder(/Message Friday/);
    await expect(input).toBeVisible({ timeout: 15_000 });
    await expect(input).toBeEnabled();
    await input.fill(`/jump ${needle}`);
    // Send enabling is the converged-state gate that the "/" keystroke
    // did not crash the autocomplete `suggestions` $derived. This spec
    // originally caught exactly that: a 502 from /api/commands during
    // env boot assigned a shapeless body to `commands`, the first "/"
    // threw `undefined.filter` inside the derived, and the poisoned
    // reactivity graph left Send permanently disabled against a
    // visibly-filled textarea (shape guard now in ChatInput's onMount).
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeEnabled();
    await send.click();

    // The window slides to cover the target, scrollTarget triggers
    // scrollIntoView (smooth, block:center) — the retrying assertion
    // absorbs the smooth-scroll duration deterministically.
    await expect(target).toBeInViewport({ timeout: 15_000 });

    await context.close();
  });
});
