/**
 * FRI-172 — Memories page redesign (RailShell + faceted filter + infinite
 * scroll + inline accordion + shallow routing).
 *
 * Browser-driven coverage for the user-visible ACs:
 *   AC2/AC3  — desktop (1024px) shows rail+main, no Filters button; mobile
 *              (375px) hides the rail, shows a `Filters (n)` button.
 *   AC4/AC4b — mobile Filters opens a role=dialog aria-modal sheet; Escape
 *              closes + restores focus to the trigger; focus moves INTO the
 *              sheet on open and Tab is trapped.
 *   AC7      — >50 filtered entries render exactly 50 initially; scrolling the
 *              bottom sentinel reveals the next batch (50 → 100).
 *   AC9      — header shows the exact `{shown} / {total}` string.
 *   AC10     — clicking a card expands inline (Markdown body) + URL becomes
 *              /memory/<id> with NO full navigation (load-stamp sentinel).
 *   AC11     — cold /memory/<id> renders the list with that card open +
 *              scrolled into view, including a target that sorts beyond the
 *              first 50.
 *   AC12     — cold /memory/<bogus> → HTTP 404 (retained loader).
 *   AC14     — `archived`-tagged entries are hidden under All, shown under
 *              Archived.
 *   AC16     — `+ New` opens a blank editor accordion; saving creates the
 *              entry, leaves its accordion open in place (URL /memory/<id>,
 *              no separate-page nav).
 *   AC18     — mobile top bar shows search + removable active-filter chips;
 *              removing a chip updates the list.
 *   AC19     — Escape collapses an open accordion (no goto; load-stamp).
 *   AC20     — the rail's TAGS region scrolls independently (scrollHeight >
 *              clientHeight) with a long seeded tag list.
 *   AC21     — Filters button + chip remove-buttons are >= 44px tall.
 *   AC22     — `+ New` and the sort <select> are keyboard-reachable/operable.
 *   AC24     — a filter combo matching nothing renders exactly one
 *              `.empty-state` (/no memories match/i) and zero MemoryCards.
 *
 * Validated by CI's playwright job (the harness boots daemon + dashboard +
 * zero-cache + scratch PG); NOT run locally against the prod stack. Conventions
 * mirror habits-route.spec.ts: cookie injection, direct pg seeding, generous
 * web-first timeouts to absorb Zero replication.
 */

import { test, expect, type Page, type Browser } from "@playwright/test";
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

/** Insert one memory_entries row at status='ready' (Zero-visible). */
async function seedMemory(
  databaseUrl: string,
  row: {
    id: string;
    title: string;
    content: string;
    tags: string[];
    updatedAt?: Date;
    recallCount?: number;
  },
): Promise<void> {
  const c = new Client({ connectionString: databaseUrl });
  c.on("error", () => {});
  await c.connect();
  try {
    const now = row.updatedAt ?? new Date();
    await c.query(
      `INSERT INTO memory_entries
         (id, title, content, tags_json, created_by, created_at, updated_at,
          file_mtime, recall_count, last_recalled_at, status)
       VALUES
         ($1, $2, $3, $4::jsonb, 'user', $5, $5, $5, $6, NULL, 'ready')
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title, content = EXCLUDED.content,
         tags_json = EXCLUDED.tags_json, updated_at = EXCLUDED.updated_at,
         recall_count = EXCLUDED.recall_count, status = 'ready'`,
      [row.id, row.title, row.content, JSON.stringify(row.tags), now, row.recallCount ?? 0],
    );
  } finally {
    await c.end();
  }
}

/** Bulk-insert many rows in a single connection (used for the >50 fixture). */
async function seedManyMemories(
  databaseUrl: string,
  rows: Array<{
    id: string;
    title: string;
    content: string;
    tags: string[];
    updatedAt: Date;
  }>,
): Promise<void> {
  const c = new Client({ connectionString: databaseUrl });
  c.on("error", () => {});
  await c.connect();
  try {
    for (const row of rows) {
      await c.query(
        `INSERT INTO memory_entries
           (id, title, content, tags_json, created_by, created_at, updated_at,
            file_mtime, recall_count, last_recalled_at, status)
         VALUES
           ($1, $2, $3, $4::jsonb, 'user', $5, $5, $5, 0, NULL, 'ready')
         ON CONFLICT (id) DO NOTHING`,
        [row.id, row.title, row.content, JSON.stringify(row.tags), row.updatedAt],
      );
    }
  } finally {
    await c.end();
  }
}

async function newAuthedPage(
  env: EnvSnapshot,
  browser: Browser,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

const cardLocator = (page: Page) => page.locator("li.memory-card");

test.describe("FRI-172: Memories redesign", () => {
  test("AC2/AC3: desktop shows rail+main (no Filters button); mobile hides rail, shows Filters", async ({
    browser,
  }) => {
    const env = loadEnv();
    const ns = `ac23-${Date.now()}`;
    // A couple of tags so the rail has facets to render.
    await seedMemory(env.databaseUrl, {
      id: `${ns}-a`,
      title: `${ns} alpha`,
      content: "alpha body",
      tags: ["user", "ops"],
    });
    await seedMemory(env.databaseUrl, {
      id: `${ns}-b`,
      title: `${ns} beta`,
      content: "beta body",
      tags: ["feedback"],
    });

    const { page, close } = await newAuthedPage(env, browser);
    try {
      // Desktop (1024px): rail + main render; the mobile Filters button is
      // absent.
      await page.setViewportSize({ width: 1024, height: 900 });
      await page.goto(`${env.dashboardURL}/memory`, { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.locator("aside.rail")).toBeVisible({ timeout: 15_000 });
      await expect(page.locator("nav.filter-rail")).toBeVisible();
      await expect(page.getByRole("button", { name: /Filters/ })).toHaveCount(0);

      // Mobile (375px): the desktop rail column is gone, a `Filters` button
      // appears.
      await page.setViewportSize({ width: 375, height: 800 });
      await expect(page.locator("aside.rail")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Filters/ })).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await close();
    }
  });

  test("AC4/AC4b: mobile Filters opens a modal sheet; focus moves in + is trapped; Escape closes + restores focus", async ({
    browser,
  }) => {
    const env = loadEnv();
    const ns = `ac4-${Date.now()}`;
    await seedMemory(env.databaseUrl, {
      id: `${ns}-a`,
      title: `${ns} alpha`,
      content: "alpha body",
      tags: ["user", "alpha-tag", "beta-tag"],
    });

    const { page, close } = await newAuthedPage(env, browser);
    try {
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(`${env.dashboardURL}/memory`, { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/\/login/);

      const trigger = page.getByRole("button", { name: /Filters/ });
      await expect(trigger).toBeVisible({ timeout: 15_000 });
      await trigger.click();

      // The sheet is a role=dialog aria-modal surface rendering the rail.
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      await expect(dialog.locator("nav.filter-rail")).toBeVisible();

      // AC4b: focus moved INTO the sheet on open.
      const focusInside = await page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        return dlg ? dlg.contains(document.activeElement) : false;
      });
      expect(focusInside).toBe(true);

      // AC4b: Tab is trapped — repeatedly tabbing keeps focus within the dialog.
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        const stillInside = await page.evaluate(() => {
          const dlg = document.querySelector('[role="dialog"]');
          return dlg ? dlg.contains(document.activeElement) : false;
        });
        expect(stillInside).toBe(true);
      }

      // AC4: Escape closes the sheet AND restores focus to the trigger.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      const focusOnTrigger = await page.evaluate(() => {
        const btn = document.activeElement as HTMLElement | null;
        return !!btn && /Filters/.test(btn.textContent ?? "");
      });
      expect(focusOnTrigger).toBe(true);
    } finally {
      await close();
    }
  });

  test("AC7/AC9: >50 entries render exactly 50, scroll reveals 50→100, header shows exact shown/total", async ({
    browser,
  }) => {
    const env = loadEnv();
    const ns = `ac7-${Date.now()}`;
    // 120 entries carrying a unique tag so the rail filter isolates this fixture
    // from the rest of the corpus. updatedAt strictly decreasing so recency sort
    // is deterministic.
    const base = Date.now();
    const rows = Array.from({ length: 120 }, (_, i) => ({
      id: `${ns}-${String(i).padStart(3, "0")}`,
      title: `${ns} entry ${String(i).padStart(3, "0")}`,
      content: `body ${i}`,
      tags: [ns],
      updatedAt: new Date(base - i * 1000),
    }));
    await seedManyMemories(env.databaseUrl, rows);

    const { page, close } = await newAuthedPage(env, browser);
    try {
      await page.setViewportSize({ width: 1024, height: 900 });
      await page.goto(`${env.dashboardURL}/memory`, { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/\/login/);

      // Filter to exactly our fixture via its unique freeform tag chip.
      const tagChip = page.locator("nav.filter-rail button.chip", {
        hasText: ns,
      });
      await expect(tagChip).toBeVisible({ timeout: 15_000 });
      await tagChip.click();

      // Initial page: exactly 50 cards.
      await expect(cardLocator(page)).toHaveCount(50, { timeout: 15_000 });
      // AC9: header reads exactly "50 / 120".
      await expect(page.getByTestId("memory-count")).toHaveText("50 / 120");

      // Scroll the bottom sentinel into view → reveal the next batch.
      await page.evaluate(() => {
        const s = document.querySelector(".sentinel");
        s?.scrollIntoView();
      });
      await expect(cardLocator(page)).toHaveCount(100, { timeout: 15_000 });

      // One more reveal exhausts the 120 fixture.
      await page.evaluate(() => {
        document.querySelector(".sentinel")?.scrollIntoView();
      });
      await expect(cardLocator(page)).toHaveCount(120, { timeout: 15_000 });
      await expect(page.getByTestId("memory-count")).toHaveText("120 / 120");
    } finally {
      await close();
    }
  });

  test("AC10/AC19: clicking a card expands inline + updates URL without navigation; Escape collapses", async ({
    browser,
  }) => {
    const env = loadEnv();
    const ns = `ac10-${Date.now()}`;
    await seedMemory(env.databaseUrl, {
      id: `${ns}-only`,
      title: `${ns} the-card`,
      content: "## Heading\n\nMarkdown **body** content.",
      tags: [ns],
    });

    const { page, close } = await newAuthedPage(env, browser);
    try {
      await page.setViewportSize({ width: 1024, height: 900 });
      await page.goto(`${env.dashboardURL}/memory`, { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/\/login/);

      // Stamp the document so we can prove no full reload happened.
      await page.evaluate(() => {
        (window as unknown as { __loadStamp: number }).__loadStamp = Date.now();
      });

      const card = cardLocator(page).filter({ hasText: `${ns} the-card` });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.locator("button.card-title").click();

      // Inline Markdown body is now visible.
      await expect(card.locator(".markdown-wrap")).toBeVisible();
      await expect(card.locator(".markdown-wrap h2")).toHaveText("Heading");
      // URL shallow-routed to /memory/<id>.
      await expect(page).toHaveURL(new RegExp(`/memory/${ns}-only$`));
      // No full navigation — the stamp survives.
      const stampAfterOpen = await page.evaluate(
        () => (window as unknown as { __loadStamp?: number }).__loadStamp,
      );
      expect(stampAfterOpen).toBeTruthy();

      // AC19: Escape collapses the accordion and returns the URL to /memory,
      // still without a reload (stamp survives).
      await page.keyboard.press("Escape");
      await expect(card.locator(".markdown-wrap")).toHaveCount(0);
      await expect(page).toHaveURL(/\/memory$/);
      const stampAfterEscape = await page.evaluate(
        () => (window as unknown as { __loadStamp?: number }).__loadStamp,
      );
      expect(stampAfterEscape).toBe(stampAfterOpen);
    } finally {
      await close();
    }
  });

  test("AC11: cold /memory/<id> opens the card (incl. a target sorted beyond the first 50) and scrolls it into view", async ({
    browser,
  }) => {
    const env = loadEnv();
    const ns = `ac11-${Date.now()}`;
    // 70 entries; recency sort is updatedAt desc. Make the DEEP target the
    // oldest so it sorts last (index ~69, beyond the first 50).
    const base = Date.now();
    const rows = Array.from({ length: 69 }, (_, i) => ({
      id: `${ns}-${String(i).padStart(3, "0")}`,
      title: `${ns} entry ${String(i).padStart(3, "0")}`,
      content: `body ${i}`,
      tags: [ns],
      updatedAt: new Date(base - i * 1000),
    }));
    const deepId = `${ns}-deep`;
    rows.push({
      id: deepId,
      title: `${ns} DEEP target`,
      content: "Deep **target** markdown body.",
      tags: [ns],
      // Oldest → sorts to the very end under recency.
      updatedAt: new Date(base - 100 * 1000),
    });
    await seedManyMemories(env.databaseUrl, rows);

    const { page, close } = await newAuthedPage(env, browser);
    try {
      await page.setViewportSize({ width: 1024, height: 900 });
      // Cold load the deep-link route directly.
      await page.goto(`${env.dashboardURL}/memory/${deepId}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page).not.toHaveURL(/\/login/);

      // The deep card exists in the DOM (slices were revealed past 50) and its
      // Markdown body is rendered (accordion open).
      const deepCard = cardLocator(page).filter({ hasText: `${ns} DEEP target` });
      await expect(deepCard).toBeVisible({ timeout: 20_000 });
      await expect(deepCard.locator(".markdown-wrap")).toBeVisible();

      // It is scrolled into view (its top is within the viewport, roughly).
      const inView = await deepCard.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= -5 && r.top < window.innerHeight;
      });
      expect(inView).toBe(true);
    } finally {
      await close();
    }
  });

  test("AC12: cold /memory/<bogus-id> returns HTTP 404", async ({ browser }) => {
    const env = loadEnv();
    const { page, close } = await newAuthedPage(env, browser);
    try {
      const resp = await page.goto(
        `${env.dashboardURL}/memory/this-id-does-not-exist-${Date.now()}`,
        { waitUntil: "domcontentloaded" },
      );
      expect(resp?.status()).toBe(404);
    } finally {
      await close();
    }
  });

  test("AC14: archived entries hidden under All, shown under Archived", async ({ browser }) => {
    const env = loadEnv();
    const ns = `ac14-${Date.now()}`;
    await seedMemory(env.databaseUrl, {
      id: `${ns}-live`,
      title: `${ns} live-entry`,
      content: "live body",
      tags: [ns, "user"],
    });
    await seedMemory(env.databaseUrl, {
      id: `${ns}-arch`,
      title: `${ns} archived-entry`,
      content: "archived body",
      tags: [ns, "archived"],
    });

    const { page, close } = await newAuthedPage(env, browser);
    try {
      await page.setViewportSize({ width: 1024, height: 900 });
      await page.goto(`${env.dashboardURL}/memory`, { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/\/login/);

      // Filter to our fixture's freeform tag (renders both under the gate).
      const tagChip = page.locator("nav.filter-rail button.chip", { hasText: ns });
      await expect(tagChip).toBeVisible({ timeout: 15_000 });
      await tagChip.click();

      // Under All (non-archived gate), only the live entry shows.
      await expect(cardLocator(page).filter({ hasText: `${ns} live-entry` })).toBeVisible({
        timeout: 15_000,
      });
      await expect(cardLocator(page).filter({ hasText: `${ns} archived-entry` })).toHaveCount(0);

      // The Archived facet renders (data-driven, count >= 1). Select it.
      const archivedChip = page.locator("nav.filter-rail button.chip", {
        hasText: /^Archived/,
      });
      await expect(archivedChip).toBeVisible();
      await archivedChip.click();

      // Now ONLY archived entries show — the live one is gone, the archived one
      // (still carrying our ns tag) appears.
      await expect(cardLocator(page).filter({ hasText: `${ns} archived-entry` })).toBeVisible({
        timeout: 15_000,
      });
      await expect(cardLocator(page).filter({ hasText: `${ns} live-entry` })).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test("AC16: + New opens a blank editor accordion; saving creates + leaves it open in place", async ({
    browser,
  }) => {
    const env = loadEnv();
    const stamp = Date.now();
    const title = `ac16 new memory ${stamp}`;
    const expectedSlug = `ac16-new-memory-${stamp}`;

    const { page, close } = await newAuthedPage(env, browser);
    try {
      await page.setViewportSize({ width: 1024, height: 900 });
      await page.goto(`${env.dashboardURL}/memory`, { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/\/login/);

      await page.evaluate(() => {
        (window as unknown as { __loadStamp: number }).__loadStamp = Date.now();
      });

      await page.getByRole("button", { name: "+ New" }).click();

      // A blank editor accordion at the top.
      const editor = page.locator("form.memory-editor");
      await expect(editor).toBeVisible({ timeout: 15_000 });

      await editor.locator("input.input").first().fill(title);
      await editor.locator("textarea.textarea").fill("created **body** content");
      await editor.getByRole("button", { name: /Create memory/ }).click();

      // The new entry's accordion is open in place; URL is the shallow
      // /memory/<slug>, NOT a separate page nav (stamp survives).
      await expect(page).toHaveURL(new RegExp(`/memory/${expectedSlug}$`), {
        timeout: 20_000,
      });
      const newCard = cardLocator(page).filter({ hasText: title });
      await expect(newCard).toBeVisible({ timeout: 15_000 });
      await expect(newCard.locator(".markdown-wrap")).toBeVisible();
      const stampAfter = await page.evaluate(
        () => (window as unknown as { __loadStamp?: number }).__loadStamp,
      );
      expect(stampAfter).toBeTruthy();
    } finally {
      await close();
    }
  });

  test("AC18/AC21: mobile top bar shows search + removable chips; chips/Filters are >= 44px", async ({
    browser,
  }) => {
    const env = loadEnv();
    const ns = `ac18-${Date.now()}`;
    await seedMemory(env.databaseUrl, {
      id: `${ns}-a`,
      title: `${ns} alpha`,
      content: "alpha body",
      tags: ["user", "feedback"],
    });

    const { page, close } = await newAuthedPage(env, browser);
    try {
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(`${env.dashboardURL}/memory`, { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/\/login/);

      // Top-bar search input is present.
      await expect(page.getByRole("searchbox", { name: /Search memories/ })).toBeVisible({
        timeout: 15_000,
      });

      // AC21: the Filters button is >= 44px tall.
      const trigger = page.getByRole("button", { name: /Filters/ });
      const triggerBox = await trigger.boundingBox();
      expect(triggerBox?.height ?? 0).toBeGreaterThanOrEqual(44);

      // Open the sheet and select two facets (user + feedback categories).
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await dialog.locator("button.chip", { hasText: /^user/ }).click();
      // Re-open if the sheet auto-closed on the first pick.
      if ((await dialog.count()) === 0) await trigger.click();
      await page
        .getByRole("dialog")
        .locator("button.chip", { hasText: /^feedback/ })
        .click();

      // Two removable active-filter chips appear in the top bar.
      const chips = page.locator(".active-chip");
      await expect(chips).toHaveCount(2, { timeout: 10_000 });

      // AC21: each chip remove-button is >= 44px tall.
      const removeBtn = page.locator(".active-chip-remove").first();
      const removeBox = await removeBtn.boundingBox();
      expect(removeBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      // Accessible remove control (AC18).
      await expect(removeBtn).toHaveAttribute("aria-label", /remove .* filter/);

      // Removing one chip updates the set → one chip remains.
      await removeBtn.click();
      await expect(chips).toHaveCount(1, { timeout: 10_000 });
    } finally {
      await close();
    }
  });

  test("AC20: the rail TAGS region scrolls independently with a long tag list", async ({
    browser,
  }) => {
    const env = loadEnv();
    const ns = `ac20-${Date.now()}`;
    // Seed many DISTINCT freeform tags so the rail's TAGS region overflows.
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: `${ns}-${String(i).padStart(3, "0")}`,
      title: `${ns} entry ${i}`,
      content: `body ${i}`,
      tags: [`${ns}-tag-${String(i).padStart(3, "0")}`],
      updatedAt: new Date(Date.now() - i * 1000),
    }));
    await seedManyMemories(env.databaseUrl, rows);

    const { page, close } = await newAuthedPage(env, browser);
    try {
      // Constrain viewport height so the bounded tag-scroll region overflows.
      await page.setViewportSize({ width: 1024, height: 600 });
      await page.goto(`${env.dashboardURL}/memory`, { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/\/login/);

      const tagScroll = page.locator("nav.filter-rail .tag-scroll");
      await expect(tagScroll).toBeVisible({ timeout: 15_000 });
      // Wait for the seeded tags to populate the region.
      await expect(tagScroll.locator("button.chip").first()).toBeVisible({ timeout: 15_000 });

      const metrics = await tagScroll.evaluate((el) => ({
        scrollH: el.scrollHeight,
        clientH: el.clientHeight,
        overflowY: getComputedStyle(el).overflowY,
      }));
      expect(metrics.overflowY === "auto" || metrics.overflowY === "scroll").toBe(true);
      expect(metrics.scrollH).toBeGreaterThan(metrics.clientH);
    } finally {
      await close();
    }
  });

  test("AC22: + New and the sort select are keyboard-reachable and operable", async ({
    browser,
  }) => {
    const env = loadEnv();
    const ns = `ac22-${Date.now()}`;
    await seedMemory(env.databaseUrl, {
      id: `${ns}-a`,
      title: `${ns} alpha`,
      content: "alpha body",
      tags: [ns],
    });

    const { page, close } = await newAuthedPage(env, browser);
    try {
      await page.setViewportSize({ width: 1024, height: 900 });
      await page.goto(`${env.dashboardURL}/memory`, { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/\/login/);

      // The sort <select> is a native control with the three options.
      const sortSelect = page.getByRole("combobox", { name: /Sort memories/ });
      await expect(sortSelect).toBeVisible({ timeout: 15_000 });
      await sortSelect.selectOption("alpha");
      await expect(sortSelect).toHaveValue("alpha");

      // The `+ New` button is focusable + activates via keyboard (Enter).
      const newBtn = page.getByRole("button", { name: "+ New" });
      await newBtn.focus();
      await expect(newBtn).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("form.memory-editor")).toBeVisible({ timeout: 10_000 });
    } finally {
      await close();
    }
  });

  test("AC24: a no-match filter combo renders exactly one .empty-state and zero cards", async ({
    browser,
  }) => {
    const env = loadEnv();
    const ns = `ac24-${Date.now()}`;
    // One entry with a category + a unique tag, but the two are split so that
    // combining them yields zero matches. Seed: entry has `user` + tagA; a
    // second entry has `feedback` + tagB. Selecting `user` category + tagB tag
    // (AND across groups) matches nothing.
    await seedMemory(env.databaseUrl, {
      id: `${ns}-a`,
      title: `${ns} alpha`,
      content: "alpha",
      tags: ["user", `${ns}-ta`],
    });
    await seedMemory(env.databaseUrl, {
      id: `${ns}-b`,
      title: `${ns} beta`,
      content: "beta",
      tags: ["feedback", `${ns}-tb`],
    });

    const { page, close } = await newAuthedPage(env, browser);
    try {
      await page.setViewportSize({ width: 1024, height: 900 });
      await page.goto(`${env.dashboardURL}/memory`, { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/\/login/);

      const rail = page.locator("nav.filter-rail");
      await expect(rail).toBeVisible({ timeout: 15_000 });
      // Select the `user` category and the `${ns}-tb` freeform tag (which only
      // the feedback entry carries) → AND across groups → zero matches.
      await rail.locator("button.chip", { hasText: /^user/ }).click();
      await expect(rail.locator("button.chip", { hasText: `${ns}-tb` })).toBeVisible();
      await rail.locator("button.chip", { hasText: `${ns}-tb` }).click();

      // Exactly one .empty-state with the loosen-filters copy; zero cards.
      const empty = page.locator("p.empty-state");
      await expect(empty).toHaveCount(1, { timeout: 15_000 });
      await expect(empty).toHaveText(/no memories match/i);
      await expect(cardLocator(page)).toHaveCount(0);
    } finally {
      await close();
    }
  });
});
