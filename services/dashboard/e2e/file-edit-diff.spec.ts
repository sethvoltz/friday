/**
 * FRI-134 — file-edit diff promotion + coverage, browser-driven.
 * FRI-137 — restored containment + header (filename + status badge), the
 * header row as the `+`/`−` disclosure control, and the smart toggle (no
 * affordance when the diff fits within the cap).
 *
 * The dashboard's unit pool runs in node with no jsdom, so the visual
 * promotion (diff shown directly, contained card + header, single cap + the
 * smart expand control, K MultiEdit hunks, NotebookEdit source view) can
 * only be asserted in a real Chromium. The pure input→props mapping is
 * unit-tested in `file-edit-input.test.ts`; the dispatch registration in
 * `tool-renderers.test.ts`; the header alias string in `tool-headlines.test.ts`;
 * the status→badge mapping in `tool-status.test.ts`; the show-toggle
 * derivation in `collapsible-toggle.test.ts`.
 *
 * AC coverage (FRI-137):
 *   AC1 — each file-edit block renders inside ONE contained card (`.file-diff`
 *         with a border-left accent rail) carrying exactly ONE header row.
 *   AC2 — the header text is the aliased filename headline produced by
 *         `synthesizeHeadline`/`aliasPath` (e.g. "Editing ~/…").
 *   AC3 — the header shows the status badge driven by the `status` prop.
 *   AC4 — the header row IS the `+`/`−` toggle (aria-expanded on the button,
 *         aria-hidden glyph, no chevrons); the old "VIEW DIFF"/"VIEW CONTENT"
 *         standalone label line is gone.
 *   AC5 — a SHORT diff (fits the 400px cap) renders fully with NO toggle
 *         (zero [aria-expanded] in the subtree, no clamp); a LONG diff renders
 *         capped (exactly ONE overflow-y:auto + max-height region) with one
 *         working toggle in the header.
 *   AC7 — diff fidelity preserved: ≥1 added + ≥1 removed row, K MultiEdit
 *         hunks, NotebookEdit replace=content view / delete=notice.
 *
 * Seeds canonical `blocks` rows directly into the scratch upstream DB
 * (mirrors zero-permissions.spec.ts), then focuses a per-test throwaway
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
  /** When set, a paired tool_result is seeded so the folded tool message
   *  resolves to `done` (FRI-137 AC3 status-badge assertion). */
  output?: string;
}

/**
 * Insert a dedicated `bare` agent pinned to a known session, then insert
 * a tool_use block per descriptor for that session. Canonical tool_use rows
 * carry `{ name, input, tool_use_id }` in content_json — the exact shape the
 * dashboard's reload path (`parseBlockContent`) reads to build a
 * `role === "tool"` message. Each seed uses a unique agent + session so the
 * tests don't cross-contaminate.
 *
 * IMPORTANT: seed a per-test throwaway agent, NEVER the shared `friday`
 * orchestrator. The earlier cut of this spec seeded `friday` (so the chat
 * landed on it at `/`), upserting `type='bare'` over the live orchestrator
 * and repointing its `session_id` at a fake session. A later test in the
 * same serial run (`live-typing`) then sent a real message to `friday`; the
 * daemon forked a `bare` worker that resumed the bogus session, which never
 * returned assistant text (a "zero-block turn") and stayed long-lived,
 * heartbeating for 60s+. zero-cache's change-streamer queued the resulting
 * write churn until it OOM-crashed (~300MB / 3k+ queued changes), after
 * which NO direct-DB-seeded row could replicate to any browser client —
 * failing todo-renderer (FRI-133), zero-permissions (FRI-129), and every
 * sidebar test (FRI-126) downstream with empty result sets. The cure is to
 * keep the shared `friday` agent pristine and drive these specs off a
 * dedicated agent via `/sessions/<agent>`.
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
      // Pair a tool_result so parseBlocks folds the tool message to `done`
      // (the header status badge then reads "done" — FRI-137 AC3). Without it
      // the message stays `running`.
      if (b.output !== undefined) {
        const resId = `${b.blockId}_res`;
        const resContent = JSON.stringify({
          tool_use_id: b.blockId,
          text: b.output,
          is_error: false,
        });
        await c.query(
          `INSERT INTO blocks
             (id, block_id, turn_id, agent_name, session_id, message_id, block_index,
              role, kind, source, content_json, status, streaming, ts)
           VALUES ($1, $1, $2, $3, $4, $5, $6,
              'assistant', 'tool_result', 'sdk', $7::jsonb, 'complete', false, now())
           ON CONFLICT (block_id) DO NOTHING`,
          [resId, turnId, agentName, sessionId, resId, b.blockIndex + 1000, resContent],
        );
      }
    }
  } finally {
    await c.end();
  }
}

/**
 * Open the dashboard authenticated and focus a SPECIFIC seeded agent via
 * `/sessions/<agent>` — never the shared `friday` orchestrator (see
 * `seedToolBlocks`). `/sessions/[agent]` mounts the same `ChatShell` as the
 * root view, so the seeded agent's current-session blocks render through the
 * identical reload path; this just keeps `friday` pristine for the rest of
 * the serial suite.
 */
async function openAgentChat(page: Page, env: EnvSnapshot, agentName: string): Promise<void> {
  await page.context().addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
  await page.goto(`${env.dashboardURL}/sessions/${agentName}`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/login/);
  // Chat input hydrated → store is live → Zero subscription open.
  await expect(page.getByPlaceholder(/Message Friday/)).toBeVisible({ timeout: 15_000 });
}

test.describe("FRI-134/FRI-137: file-edit diff promotion + restored header", () => {
  test("AC1/AC2/AC3/AC5 — short Edit: contained card + aliased header + status badge, NO toggle", async ({
    browser,
  }) => {
    const env = loadEnv();
    const agent = `fed-edit-${Date.now()}`;
    const session = `s_edit_${Date.now()}`;
    // A home-dir path so the header aliases to "~/…" via synthesizeHeadline.
    // The dashboard's homeDir is the test host's $HOME (+layout.server.ts).
    const home = process.env.HOME ?? "";
    const filePath = `${home}/fri137/sample.ts`;
    await seedToolBlocks(env.databaseUrl, agent, session, [
      {
        blockId: `te_${Date.now()}`,
        toolName: "Edit",
        // A few lines — comfortably shorter than the 400px cap, so AC5's
        // "fits → no toggle" branch fires.
        input: {
          file_path: filePath,
          old_string: "const a = 1;\nconst b = 2;\nconst c = 3;",
          new_string: "const a = 1;\nconst b = 22;\nconst c = 3;\nconst d = 4;",
        },
        blockIndex: 0,
        output: "edit applied",
      },
    ]);

    const context = await browser.newContext();
    const page = await context.newPage();
    await openAgentChat(page, env, agent);

    // The file-edit renderer mounts FileDiff directly. Scope to it.
    const fileDiff = page.locator(".file-diff").first();
    await expect(fileDiff).toBeVisible({ timeout: 20_000 });

    // AC1: exactly ONE contained card with a visible border-left accent rail
    // (distinct from the page background) and exactly ONE header row.
    await expect(page.locator(".file-diff")).toHaveCount(1);
    const head = fileDiff.locator(".file-diff-head");
    await expect(head).toHaveCount(1);
    const railWidth = await fileDiff.evaluate((el) => getComputedStyle(el).borderLeftWidth);
    expect(railWidth).toBe("2px");

    // AC1: still NO generic ToolBlock card (.tool-head) — the diff is promoted.
    await expect(page.locator(".tool-head")).toHaveCount(0);

    // AC2: header text is the aliased filename headline (synthesizeHeadline →
    // aliasPath). A home-dir path renders "Editing ~/fri137/sample.ts".
    await expect(fileDiff.locator(".file-diff-name")).toHaveText("Editing ~/fri137/sample.ts");

    // AC3: status badge reflects the `status` prop — done (paired tool_result).
    const badge = head.locator(".badge");
    await expect(badge).toHaveText("done");
    await expect(badge).toHaveClass(/\bok\b/);

    // AC7: diff fidelity — real added + removed rows render.
    await expect(fileDiff.locator(".diff-row.diff-added").first()).toBeVisible();
    await expect(fileDiff.locator(".diff-row.diff-removed").first()).toBeVisible();

    // AC5 (fits): NO toggle affordance — zero [aria-expanded] in the subtree,
    // the old standalone "VIEW DIFF" label is gone, and no clamped scroll
    // region (content shown in full).
    await expect(fileDiff.locator("[aria-expanded]")).toHaveCount(0);
    await expect(page.getByText(/view diff/i)).toHaveCount(0);
    await expect(page.getByText(/view content/i)).toHaveCount(0);
    const scrollRegions = await fileDiff.evaluate((root) => {
      const all = Array.from(root.querySelectorAll<HTMLElement>("*"));
      return all.filter((el) => {
        const cs = getComputedStyle(el);
        return cs.overflowY === "auto" && cs.maxHeight !== "none" && cs.maxHeight !== "";
      }).length;
    });
    expect(scrollRegions).toBe(0);

    await context.close();
  });

  test("AC4/AC5 — long Edit: header row IS the +/- toggle, capped with ONE scroll region", async ({
    browser,
  }) => {
    const env = loadEnv();
    const agent = `fed-long-${Date.now()}`;
    const session = `s_long_${Date.now()}`;
    // ~120 changed lines so the diff comfortably exceeds the 400px cap.
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (let i = 0; i < 120; i++) {
      oldLines.push(`const v${i} = ${i};`);
      newLines.push(`const v${i} = ${i + 1};`);
    }
    await seedToolBlocks(env.databaseUrl, agent, session, [
      {
        blockId: `tl_${Date.now()}`,
        toolName: "Edit",
        input: {
          file_path: "/tmp/fri137/long.ts",
          old_string: oldLines.join("\n"),
          new_string: newLines.join("\n"),
        },
        blockIndex: 0,
      },
    ]);

    const context = await browser.newContext();
    const page = await context.newPage();
    await openAgentChat(page, env, agent);

    const fileDiff = page.locator(".file-diff").first();
    await expect(fileDiff).toBeVisible({ timeout: 20_000 });

    // AC4: the header row IS the disclosure control — exactly ONE
    // [aria-expanded], and it lives on the header button (.file-diff-head).
    const toggles = fileDiff.locator("[aria-expanded]");
    await expect(toggles).toHaveCount(1);
    const toggle = fileDiff.locator("button.file-diff-head");
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toHaveAttribute("aria-expanded", /true|false/);

    // AC4: the disclosure glyph is +/− and aria-hidden; no chevrons.
    const glyph = toggle.locator(".file-diff-glyph");
    await expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(["+", "−"]).toContain((await glyph.textContent())?.trim());
    const headText = (await toggle.textContent()) ?? "";
    expect(headText).not.toMatch(/[▸▾▴►◄‣⌄⌃]/);

    // AC4: the standalone "VIEW DIFF"/"VIEW CONTENT" label line is gone.
    await expect(page.getByText(/view diff/i)).toHaveCount(0);
    await expect(page.getByText(/view content/i)).toHaveCount(0);

    // AC5 (overflows): toggle works — clicking flips aria-expanded and, when
    // collapsed, there is exactly ONE scrollable region (overflow-y:auto +
    // a real max-height clamp). FileDiff is startOpen=true.
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
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    // Still exactly one CollapsibleSection (single shared cap).
    await expect(fileDiff.locator(".collapsible")).toHaveCount(1);

    await context.close();
  });

  test("AC4/AC7 — a 3-edit MultiEdit renders exactly 3 diff hunk groups", async ({ browser }) => {
    const env = loadEnv();
    const agent = `fed-multi-${Date.now()}`;
    const session = `s_multi_${Date.now()}`;
    await seedToolBlocks(env.databaseUrl, agent, session, [
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
    await openAgentChat(page, env, agent);

    const fileDiff = page.locator(".file-diff").first();
    await expect(fileDiff).toBeVisible({ timeout: 20_000 });

    // AC7: exactly 3 hunk groups (one .diff-hunk per edit).
    await expect(fileDiff.locator(".diff-hunk")).toHaveCount(3);
    // Still exactly one CollapsibleSection shared across all 3 hunks (no
    // per-hunk scroller). The header row is present (filename + status badge).
    await expect(fileDiff.locator(".collapsible")).toHaveCount(1);
    await expect(fileDiff.locator(".file-diff-head")).toHaveCount(1);
    await expect(fileDiff.locator(".file-diff-name")).toContainText("multi.ts");
    // AC5 (fits): three one-word hunks are well under the 400px cap → NO
    // toggle affordance.
    await expect(fileDiff.locator("[aria-expanded]")).toHaveCount(0);

    await context.close();
  });

  test("AC5/AC7 — NotebookEdit replace shows a source view, delete shows a notice", async ({
    browser,
  }) => {
    const env = loadEnv();
    const agent = `fed-nb-${Date.now()}`;
    const session = `s_nb_${Date.now()}`;
    await seedToolBlocks(env.databaseUrl, agent, session, [
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
    await openAgentChat(page, env, agent);

    const diffs = page.locator(".file-diff");
    await expect(diffs).toHaveCount(2, { timeout: 20_000 });

    // Each NotebookEdit block carries its own contained card + header row.
    await expect(diffs.nth(0).locator(".file-diff-head")).toHaveCount(1);
    await expect(diffs.nth(1).locator(".file-diff-head")).toHaveCount(1);

    // AC7: replace → content view: a .block-pre (code block), NOT a two-sided
    // diff. The header reads "Editing …analysis.ipynb".
    const replaceDiff = diffs.nth(0);
    await expect(replaceDiff.locator(".block-pre")).toHaveCount(1);
    await expect(replaceDiff.locator(".diff-side-by-side")).toHaveCount(0);
    await expect(replaceDiff.locator(".file-diff-name")).toContainText("analysis.ipynb");

    // AC7: delete → "cell deleted" notice, no code body.
    const deleteDiff = diffs.nth(1);
    await expect(deleteDiff.locator(".cell-deleted")).toHaveCount(1);
    await expect(deleteDiff.locator(".block-pre")).toHaveCount(0);

    await context.close();
  });
});
