/**
 * Sidebar click-bleed-through regression suite (FRI-126).
 *
 * The bug: after multiple focus switches between sidebar agents, taps
 * that should land on a row's `.expand-btn` (the +/- history glyph)
 * instead landed on the sibling `.row-main` underneath — re-navigating
 * to the agent rather than toggling its history. Two compounding causes:
 *
 *   Cause 1 (always-on geometry): the `.expand-slot` overlay had
 *   `pointer-events: none`, so a tap anywhere in its 4rem box except the
 *   inner 1.85rem button fell through to `.row-main`. The fix makes the
 *   whole slot a `toggleHistory` hit target.
 *
 *   Cause 2 (rapid-switch reflow): `goto(...)` is async; the route — and
 *   the history-block mount/unmount it drives — settles a microtask after
 *   the click handler returns. On touch, a `pointerdown` on row B's glyph
 *   whose `pointerup` lands after the rows shift gets its synthetic click
 *   coalesced onto a different row. The fix pins the pointerdown row and
 *   swallows a focus click that surfaces on a row it didn't start on.
 *
 * This suite must run with `hasTouch: true` (the `chromium-touch`
 * project) to exercise the `@media (hover: none)` always-opaque slot —
 * the platform where the bug bit hardest. The geometry assertions use
 * coordinate-based `page.mouse.click(x, y)` derived from `boundingBox()`
 * rather than `locator.click()`, because `locator.click()` scrolls the
 * element to centre and clicks its middle, which would mask exactly the
 * hit-test gap under test.
 *
 * Seeding: three non-orchestrator agents, each with `session_count >= 2`
 * (so the +/- button renders per the gate at Sidebar.svelte:432) and a
 * past session distinct from the current one (so the history submenu has
 * a `.history-row` to click for AC #8). `session_count` is maintained by
 * the `friday_blocks_increment_session_count_trigger`, so we seed it by
 * inserting blocks across distinct `(agent, session_id)` pairs rather
 * than writing the column directly.
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
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    return {
      name,
      value,
      domain: u.hostname,
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax" as const,
    };
  });
}

// Unique per-run agent names so a re-run against a non-truncated DB
// can't collide. Stable within one run (computed once at module load).
const RUN = Date.now().toString(36);
const agA = { name: `clk-a-${RUN}`, current: "s-a-cur", past: "s-a-past" };
const agB = { name: `clk-b-${RUN}`, current: "s-b-cur", past: "s-b-past" };
const agC = { name: `clk-c-${RUN}`, current: "s-c-cur", past: "s-c-past" };
const SEEDED = [agA, agB, agC];

/**
 * Seed an agent that renders the +/- button and has a past session.
 * Inserts blocks across the "current" and "past" sessions so the
 * increment trigger bumps `session_count` to 2; then points the agent's
 * `session_id` at the current session so `pastFor(...)` surfaces only the
 * past one in the history submenu.
 */
async function seedAgent(
  c: Client,
  ag: { name: string; current: string; past: string },
): Promise<void> {
  const now = new Date();
  await c.query(
    `INSERT INTO agents (name, type, status, session_id, session_count, created_at, updated_at)
       VALUES ($1, 'bare', 'idle', $2, 0, $3, $3)
       ON CONFLICT (name) DO NOTHING`,
    [ag.name, ag.current, now],
  );
  // Two distinct sessions × two distinct turns each → session_count 2,
  // turnCount 2 per session. The trigger fires on the first block of each
  // novel (agent, session_id) pair.
  for (const session of [ag.past, ag.current]) {
    for (const turn of ["t1", "t2"]) {
      await c.query(
        `INSERT INTO blocks
           (id, block_id, turn_id, agent_name, session_id, block_index,
            role, kind, source, content_json, status, ts)
         VALUES
           (gen_random_uuid()::text, $1, $2, $3, $4, 0,
            'assistant', 'text', NULL, '{"text":""}'::jsonb, 'complete', now())`,
        [`blk-${ag.name}-${session}-${turn}`, `${ag.name}-${session}-${turn}`, ag.name, session],
      );
    }
  }
}

async function seedAll(databaseUrl: string): Promise<void> {
  const c = new Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    for (const ag of SEEDED) await seedAgent(c, ag);
  } finally {
    await c.end();
  }
}

function rowSel(name: string): string {
  return `.row[data-agent="${name}"]`;
}

/** Centre of an element's visible bounding box. */
async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Coordinate-based click at the centre of the agent's +/- glyph. Uses
 * `page.mouse.click` rather than `locator.click()` so the click lands at
 * the literal screen coordinate and does NOT auto-scroll-and-recentre —
 * that auto-retargeting is exactly what would mask the hit-test gap.
 */
async function tapExpandGlyph(page: Page, name: string): Promise<void> {
  const { x, y } = await centreOf(page, `${rowSel(name)} .expand-btn`);
  await page.mouse.click(x, y);
}

/**
 * Coordinate-based tap in the expand-slot's *fade band* — the part of the
 * 4rem slot that lies to the LEFT of the inner 1.85rem glyph button. THIS
 * is the exact region the click-bleed bug lived in: before the fix the
 * slot carried `pointer-events: none`, so a tap here fell through to
 * `.row-main` underneath and re-focused the agent instead of toggling its
 * history. Tapping the glyph *centre* (tapExpandGlyph) never reproduced
 * the bug because the inner button always had `pointer-events: auto`.
 *
 * Targets a point 6px inside the slot's left edge (safely within the fade
 * band; the button starts ~27px further right at this width) and asserts
 * up-front that the chosen point is genuinely outside the button box so
 * the test fails loudly if the layout ever shrinks the band to nothing.
 */
async function tapExpandSlotFadeBand(page: Page, name: string): Promise<void> {
  const slot = await page.locator(`${rowSel(name)} .expand-slot`).boundingBox();
  const btn = await page.locator(`${rowSel(name)} .expand-btn`).boundingBox();
  if (!slot) throw new Error(`no bounding box for ${name} .expand-slot`);
  if (!btn) throw new Error(`no bounding box for ${name} .expand-btn`);
  const x = slot.x + 6;
  const y = slot.y + slot.height / 2;
  expect(
    x,
    `fade-band tap x (${x}) must be strictly left of the glyph button (starts at ${btn.x}) — otherwise this isn't testing the bleed-through region`,
  ).toBeLessThan(btn.x);
  await page.mouse.click(x, y);
}

/**
 * Drive N alternating focus switches between two rows via coordinate
 * clicks on each row's label region, waiting on the visible URL between
 * each (the route is not synchronously observable from Playwright; the
 * URL is the user-visible proxy and the only thing we can deterministically
 * await). Returns having last focused `b`.
 */
async function alternateFocus(page: Page, a: string, b: string, switches: number): Promise<void> {
  for (let i = 0; i < switches; i++) {
    const target = i % 2 === 0 ? a : b;
    // Click the row's left edge — well inside .row-main, clear of the
    // 4rem right-edge slot strip.
    const box = await page.locator(rowSel(target)).boundingBox();
    if (!box) throw new Error(`no bounding box for row ${target}`);
    await page.mouse.click(box.x + 16, box.y + box.height / 2);
    await page.waitForURL(new RegExp("/sessions/" + target + "(/.*)?$"));
  }
}

async function gotoSidebar(page: Page, env: EnvSnapshot): Promise<void> {
  await page.goto(env.dashboardURL, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/login/);

  // Wait for the Zero-replicated rows to hydrate. All three seeded rows
  // must be present before we start clicking — they carry the +/- button.
  //
  // Before FRI-129 the scratch sync harness booted zero-cache without
  // running `zero-deploy-permissions`, so Zero's deny-all default served
  // the sidebar `agents` query empty even though the seeded rows were in
  // Postgres and the replication slot had advanced past their LSN — the
  // rows never materialized on the client and this suite was inert behind
  // a `test.skip`. FRI-129 (#108) now deploys permissions before spawning
  // zero-cache (mirroring production's supervisor `preStart`), so the
  // seeded rows DO reach the browser. The skip guard is gone: a row that
  // fails to appear is now a hard failure, not a skip.
  for (const ag of SEEDED) {
    await expect(page.locator(rowSel(ag.name))).toBeVisible({ timeout: 25_000 });
    await expect(page.locator(`${rowSel(ag.name)} .expand-btn`)).toBeAttached({
      timeout: 20_000,
    });
  }
}

test.beforeAll(async () => {
  const env = loadEnv();
  await seedAll(env.databaseUrl);
});

test.describe("sidebar click targets after focus switches (FRI-126)", () => {
  test("AC1 (Prong A): a tap in the slot's fade band toggles history — NOT focus (the bleed-through region)", async ({
    browser,
  }) => {
    // The load-bearing case. Tapping the part of the 4rem slot to the LEFT
    // of the glyph button is what bled through to `.row-main` before the
    // fix. No focus switches needed: Prong A is a pure-geometry bug — the
    // slot was `pointer-events: none`, so a tap in the fade band hit the
    // row underneath on the very first interaction. With the fix the whole
    // slot is a `toggleHistory` hit target; without it this tap navigates.
    const env = loadEnv();
    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();
    await gotoSidebar(page, env);

    // Start on the orchestrator route so a stray focus would visibly change
    // the URL to /sessions/<agC>. agC starts collapsed.
    await expect(page).toHaveURL(/\/$|\/sessions\/friday/);
    await expect(page.locator(`${rowSel(agC.name)} .expand-btn`)).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await tapExpandSlotFadeBand(page, agC.name);

    // Must toggle agC's history and must NOT navigate to agC. Pre-fix, the
    // fade-band tap fell through to `.row-main` → focusAgent → goto(agC):
    // the URL would become /sessions/<agC> and aria-expanded would stay
    // "false". Both assertions therefore fail without the Prong-A fix.
    await expect(page.locator(`${rowSel(agC.name)} .expand-btn`)).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page).not.toHaveURL(new RegExp("/sessions/" + agC.name + "(/.*)?$"));

    await context.close();
  });

  test("AC2: after 10 alternating focus switches, an expand-glyph tap toggles history — not focus", async ({
    browser,
  }) => {
    const env = loadEnv();
    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();
    await gotoSidebar(page, env);

    // Confirm agC starts collapsed so the post-tap assertion is meaningful.
    await expect(page.locator(`${rowSel(agC.name)} .expand-btn`)).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await alternateFocus(page, agA.name, agB.name, 10);
    await expect(page).toHaveURL(new RegExp("/sessions/" + agB.name + "(/.*)?$"));

    // Coordinate-based tap in agC's slot fade band (left of the glyph) —
    // the bleed-through region, exercised here AFTER 10 focus switches so
    // the slot's interactivity is still correct once the rows have churned.
    // Must toggle agC's history (aria-expanded → true) and must NOT
    // navigate to agC (the URL stays on agB).
    await tapExpandSlotFadeBand(page, agC.name);

    await expect(page).toHaveURL(new RegExp("/sessions/" + agB.name + "(/.*)?$"));
    await expect(page.locator(`${rowSel(agC.name)} .expand-btn`)).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await context.close();
  });

  test("AC3: back-to-back glyph taps across a mid-gesture layout shift both hit their own row", async ({
    browser,
  }) => {
    const env = loadEnv();
    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();
    await gotoSidebar(page, env);

    await alternateFocus(page, agA.name, agB.name, 10);
    await expect(page).toHaveURL(new RegExp("/sessions/" + agB.name + "(/.*)?$"));

    // Toggle agB's history (mounts its history block, shifting agC down),
    // then immediately tap agC's glyph back-to-back with no intervening
    // wait. agC's coordinate is recomputed AFTER the agB toggle so the tap
    // lands on agC's post-shift glyph position. Both must toggle their own
    // row; the URL must stay on agB.
    await page.locator(`${rowSel(agB.name)} .expand-btn`).click();
    await tapExpandGlyph(page, agC.name);

    await expect(page).toHaveURL(new RegExp("/sessions/" + agB.name + "(/.*)?$"));
    await expect(page.locator(`${rowSel(agB.name)} .expand-btn`)).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.locator(`${rowSel(agC.name)} .expand-btn`)).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await context.close();
  });

  test("AC4: elementFromPoint resolves inside the toggle target — at the glyph centre AND in the fade band — never .row-main", async ({
    browser,
  }) => {
    const env = loadEnv();
    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();
    await gotoSidebar(page, env);

    await alternateFocus(page, agA.name, agB.name, 10);

    for (const ag of SEEDED) {
      // (a) The glyph centre resolves inside the inner button. This holds
      // even pre-fix (the button always had pointer-events: auto), so on
      // its own it does NOT guard the bug — it's the baseline sanity check.
      const { x, y } = await centreOf(page, `${rowSel(ag.name)} .expand-btn`);
      const resolvesInsideBtn = await page.evaluate(
        ({ px, py }) => {
          const el = document.elementFromPoint(px, py);
          return !!(el && (el as Element).closest(".expand-btn"));
        },
        { px: x, py: y },
      );
      expect(
        resolvesInsideBtn,
        `elementFromPoint at ${ag.name}'s glyph centre should resolve inside .expand-btn`,
      ).toBe(true);

      // (b) The LOAD-BEARING check: a point in the slot's fade band (left
      // of the button) must resolve inside the .expand-slot toggle target
      // and must NOT resolve to .row-main underneath. Pre-fix the slot was
      // `pointer-events: none`, so elementFromPoint here returned the
      // `.row-main` button beneath — the bleed-through. The recorded box
      // for the slot and button confirm a real band exists to sample.
      const slot = await page.locator(`${rowSel(ag.name)} .expand-slot`).boundingBox();
      const btn = await page.locator(`${rowSel(ag.name)} .expand-btn`).boundingBox();
      if (!slot) throw new Error(`no bounding box for ${ag.name} .expand-slot`);
      if (!btn) throw new Error(`no bounding box for ${ag.name} .expand-btn`);
      const fadeX = slot.x + 6;
      const fadeY = slot.y + slot.height / 2;
      expect(
        fadeX,
        `fade-band sample x (${fadeX}) must be left of the glyph button (starts at ${btn.x})`,
      ).toBeLessThan(btn.x);
      const resolution = await page.evaluate(
        ({ px, py }) => {
          const el = document.elementFromPoint(px, py);
          if (!el) return "null";
          if ((el as Element).closest(".expand-slot")) return "expand-slot";
          if ((el as Element).closest(".row-main")) return "row-main";
          return (el as Element).className || (el as Element).tagName;
        },
        { px: fadeX, py: fadeY },
      );
      expect(
        resolution,
        `elementFromPoint in ${ag.name}'s slot fade band must hit the .expand-slot toggle target, not .row-main (the bleed-through)`,
      ).toBe("expand-slot");
    }

    await context.close();
  });

  test("AC7: clicking the agent name still focuses (URL changes); re-tapping the active row is idempotent", async ({
    browser,
  }) => {
    const env = loadEnv();
    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();
    await gotoSidebar(page, env);

    // Label-region tap on agA (left edge, outside the 4rem slot strip)
    // navigates to agA.
    const boxA = await page.locator(rowSel(agA.name)).boundingBox();
    if (!boxA) throw new Error("no bounding box for agA row");
    await page.mouse.click(boxA.x + 16, boxA.y + boxA.height / 2);
    await page.waitForURL(new RegExp("/sessions/" + agA.name + "(/.*)?$"));
    await expect(page).toHaveURL(new RegExp("/sessions/" + agA.name + "(/.*)?$"));

    // Re-tapping the now-active row is idempotent: still on agA, no error.
    const boxA2 = await page.locator(rowSel(agA.name)).boundingBox();
    if (!boxA2) throw new Error("no bounding box for agA row (2nd)");
    await page.mouse.click(boxA2.x + 16, boxA2.y + boxA2.height / 2);
    await expect(page).toHaveURL(new RegExp("/sessions/" + agA.name + "(/.*)?$"));

    await context.close();
  });

  test("AC8: clicking a history row navigates to /sessions/<agent>/<session>", async ({
    browser,
  }) => {
    const env = loadEnv();
    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();
    await gotoSidebar(page, env);

    // Expand agA's history, wait for the (non-current) past session row to
    // render, then click it. The agent's current session is filtered out by
    // pastFor(...), so the visible history row is the past session.
    await page.locator(`${rowSel(agA.name)} .expand-btn`).click();
    const historyRow = page.locator(`${rowSel(agA.name)} + .history .history-row`).first();
    await expect(historyRow).toBeVisible({ timeout: 10_000 });
    await historyRow.click();

    await expect(page).toHaveURL(new RegExp("/sessions/" + agA.name + "/" + agA.past + "$"));

    await context.close();
  });
});
