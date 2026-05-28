/**
 * Appearance / theming e2e — FRI-124.
 *
 * Pins the DOM + runtime behavior that ⌘K and the Appearance settings
 * card produce against a real Chromium. Covers the AC items that
 * unit tests can't reach because they depend on stamped <html>
 * classes, browser `style.colorScheme`, the live <meta name="theme-
 * color"> tag, and cross-tab Zero sync.
 *
 * AC coverage:
 *   #10 — palette switch updates html.classList atomically
 *   #11 — html.style.colorScheme follows active palette kind
 *   #12 — meta[name="theme-color"] follows active palette themeColor
 *   #25 — each palette preview card resolves --accent-primary against
 *         its own palette scope, regardless of the active palette
 *   #26 — ⌘K Theme entries are exactly [Sync, Dawn, Dusk] in order
 *   #27 — cross-tab Zero sync converges a palette change
 *
 * Out of scope here (covered by unit tests):
 *   - Shiki re-highlight (AC #21) — covered by the Markdown.svelte
 *     code path's `theme.activePalette` $effect; e2e validation
 *     requires a rendered chat with a fenced code block, which
 *     mid-stream involves the full chat round-trip. Left for a
 *     follow-up suite that already exercises chat rendering.
 *   - Mermaid re-render (AC #22) — same constraint.
 */

import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
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

/** Same cookie shape live-typing.spec.ts uses; the helper is small
 *  enough to inline rather than share. */
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

/** Open the dashboard at the given path with the session cookie pre-
 *  installed and localStorage cleared so each test starts from boot
 *  defaults. */
async function openDashboard(page: Page, env: EnvSnapshot, path = "/"): Promise<void> {
  await page.context().addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
  // Clear localStorage on the dashboard origin before navigation so
  // the FOUC script lands on its default branch (no cached Theme).
  await page.goto(env.dashboardURL + "/");
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {}
  });
  if (path !== "/") await page.goto(env.dashboardURL + path);
  else await page.goto(env.dashboardURL + "/");
}

/** Read <html> attributes that bindTheme + the FOUC script drive. */
async function readDocumentState(page: Page): Promise<{
  classList: string[];
  colorScheme: string;
  themeColor: string | null;
}> {
  return page.evaluate(() => ({
    classList: Array.from(document.documentElement.classList),
    colorScheme: document.documentElement.style.colorScheme,
    themeColor:
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? null,
  }));
}

test.describe("Appearance — runtime DOM updates", () => {
  test("palette switch atomically stamps .palette-<name>, .dark (per kind), colorScheme, theme-color", async ({
    page,
  }) => {
    const env = loadEnv();
    await openDashboard(page, env, "/settings");
    await page.waitForLoadState("networkidle");

    // Sanity: boot lands on the dusk default (the FOUC script either
    // resolves to Dusk via DEFAULTS.dark when system pref is dark, or
    // Dawn via DEFAULTS.light otherwise; the boot class in app.html is
    // explicitly palette-dusk dark). Read the present state and let
    // the test work from whatever booted.
    const start = await readDocumentState(page);
    expect(start.classList.some((c) => c.startsWith("palette-"))).toBe(true);

    // Click "Single theme" to escape Sync (default), then pick Dawn.
    await page.getByRole("button", { name: /^Single theme$/ }).click();
    // The palette cards are inside the Appearance card; the button text
    // is the palette name ("Dawn" / "Dusk").
    await page.getByRole("button", { name: /^Dawn$/ }).first().click();

    await expect.poll(() => readDocumentState(page).then((s) => s.classList)).toContain(
      "palette-dawn",
    );
    const afterDawn = await readDocumentState(page);
    expect(afterDawn.classList).toContain("palette-dawn");
    expect(afterDawn.classList).not.toContain("palette-dusk");
    expect(afterDawn.classList).not.toContain("dark"); // dawn is light-kind
    expect(afterDawn.colorScheme).toBe("light");
    expect(afterDawn.themeColor).toBe("#faf6f1");

    // Now switch to Dusk and assert the inverse.
    await page.getByRole("button", { name: /^Dusk$/ }).first().click();
    await expect.poll(() => readDocumentState(page).then((s) => s.classList)).toContain(
      "palette-dusk",
    );
    const afterDusk = await readDocumentState(page);
    expect(afterDusk.classList).toContain("palette-dusk");
    expect(afterDusk.classList).not.toContain("palette-dawn");
    expect(afterDusk.classList).toContain("dark"); // dusk is dark-kind
    expect(afterDusk.colorScheme).toBe("dark");
    expect(afterDusk.themeColor).toBe("#0f1219");
  });

  test("palette preview cards compute --accent-primary in their own scope", async ({ page }) => {
    const env = loadEnv();
    await openDashboard(page, env, "/settings");
    await page.waitForLoadState("networkidle");

    // Ensure both Dawn and Dusk preview cards are visible. Pick Single
    // mode so there's exactly one palette grid (the Sync UI has two
    // grids, each card duplicated).
    await page.getByRole("button", { name: /^Single theme$/ }).click();

    // Each card is `<button class="palette-card palette-<name>">`; the
    // computed --accent-primary inside MUST resolve from THAT palette,
    // independent of the active one.
    const dawnAccent = await page
      .locator(".palette-card.palette-dawn")
      .first()
      .evaluate((el) => getComputedStyle(el).getPropertyValue("--accent-primary").trim());
    const duskAccent = await page
      .locator(".palette-card.palette-dusk")
      .first()
      .evaluate((el) => getComputedStyle(el).getPropertyValue("--accent-primary").trim());

    expect(dawnAccent.toLowerCase()).toBe("#c4956a");
    expect(duskAccent.toLowerCase()).toBe("#5b8edd");
  });
});

test.describe("Appearance — ⌘K", () => {
  test("Theme section labels are exactly [Sync, Dawn, Dusk] in order", async ({ page }) => {
    const env = loadEnv();
    await openDashboard(page, env, "/");
    await page.waitForLoadState("networkidle");

    // Open ⌘K via the documented keyboard shortcut.
    await page.keyboard.press("Meta+k");
    // Filter to the Theme section.
    await page.getByRole("textbox", { name: /Search/i }).fill("Theme");

    // The ⌘K palette renders `<button class="palette-row">` rows. We
    // assert the *labels* of the visible Theme rows match the expected
    // array exactly. The Settings section's items have ids of the form
    // theme.sync / theme.palette.dawn / theme.palette.dusk.
    const labels = await page
      .locator('[role="option"]')
      .evaluateAll((nodes) =>
        nodes
          .map((n) => {
            // Label sits in `.palette-label`; mark text aside, the
            // logical label is the concatenation of all text spans.
            return n.querySelector(".palette-label")?.textContent?.trim() ?? "";
          })
          .filter((s) => s.startsWith("Theme:")),
      );
    expect(labels).toEqual(["Theme: Sync with system", "Theme: Dawn", "Theme: Dusk"]);
  });

  test("picking a palette from ⌘K switches to Single mode + applies", async ({ page }) => {
    const env = loadEnv();
    await openDashboard(page, env, "/");
    await page.waitForLoadState("networkidle");

    await page.keyboard.press("Meta+k");
    await page.getByRole("textbox", { name: /Search/i }).fill("Theme Dawn");
    // Press Enter on the active row.
    await page.keyboard.press("Enter");

    await expect.poll(() => readDocumentState(page).then((s) => s.classList)).toContain(
      "palette-dawn",
    );

    // Re-open ⌘K and confirm "Theme: Dawn" is now flagged as current.
    await page.keyboard.press("Meta+k");
    await page.getByRole("textbox", { name: /Search/i }).fill("Theme");
    const dawnIsCurrent = await page
      .locator('[role="option"]')
      .evaluateAll((nodes) =>
        nodes.some((n) => {
          const label = n.querySelector(".palette-label")?.textContent?.trim() ?? "";
          const hasCurrent = !!n.querySelector(".palette-current");
          return label === "Theme: Dawn" && hasCurrent;
        }),
      );
    expect(dawnIsCurrent).toBe(true);
  });
});

test.describe("Appearance — cross-tab Zero sync", () => {
  test("changing palette in tab A converges to tab B without a manual reload", async ({
    browser,
  }) => {
    const env = loadEnv();
    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const a = await context.newPage();
    const b = await context.newPage();
    await a.goto(env.dashboardURL + "/settings");
    await b.goto(env.dashboardURL + "/");
    await Promise.all([a.waitForLoadState("networkidle"), b.waitForLoadState("networkidle")]);

    // Tab A switches to Single + Dawn. Tab B is on /; expect its <html>
    // to pick up palette-dawn within a couple seconds via Zero replay.
    await a.getByRole("button", { name: /^Single theme$/ }).click();
    await a.getByRole("button", { name: /^Dawn$/ }).first().click();

    await expect
      .poll(
        async () =>
          await b.evaluate(() => Array.from(document.documentElement.classList).join(" ")),
        { timeout: 4_000 },
      )
      .toContain("palette-dawn");

    await context.close();
  });
});
