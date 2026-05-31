/**
 * friday-mail tool-call renderer e2e (FRI-135).
 *
 * Drives the MailToolBlock renderer (registered in tool-renderers.ts for
 * `mail_send` / `mail_inbox` / `mail_read` / `mail_close`) against a real
 * Chromium. The dashboard's vitest pool has no DOM, so the renderer's
 * *visual* output can only be asserted in the browser — which is exactly
 * what this suite does.
 *
 * Rendering path: the per-tool renderer registry runs on the canonical
 * Zero-replicated `blocks` rows. We seed a `tool_use` + paired
 * `tool_result` block under a *past* session and open the read-only
 * past-session view (`/sessions/<agent>/<session>`), which renders
 * `pastMessages` purely from `parseBlocks(zeroSync.blocks filtered by
 * session_id)` — no daemon turn, no ANTHROPIC_API_KEY, fully
 * deterministic. parseBlocks folds the tool_use (name + input) and
 * tool_result (output text) into one `role:"tool"` message whose
 * `toolName` is `mcp__friday-mail__mail_*`, which `resolveToolRenderer`
 * routes to MailToolBlock via the `/^mcp__[^_]+__(.+)$/` short segment.
 *
 * Seeded `content_json` mirrors the daemon's wire shape exactly
 * (services/daemon/src/agent/block-stream.ts): tool_use →
 * `{tool_use_id, name, input}`; tool_result → `{tool_use_id, text,
 * is_error}`.
 *
 * AC coverage:
 *   #7  — mail_send preview shows to / subject / priority / body-snippet,
 *         and NO raw `"body":` JSON key in the visible card.
 *   #8  — mail_read summary shows from / subject / body parsed from output
 *         (no raw `"fromAgent":` key); a null-subject read renders without
 *         the literal string "null" as the subject.
 *   #9  — a critical-priority mail_send tints the priority element with
 *         `.priority-critical` → color: var(--status-error).
 *   #11 — running/undefined-input mail_send renders headline + running
 *         badge and does not throw; empty mail_inbox renders "Inbox empty";
 *         a non-JSON mail_read output falls back to showing the raw text.
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

// Unique per-run agent name so a re-run against a non-truncated DB can't
// collide. Each test seeds its tool blocks under its own session id.
const RUN = Date.now().toString(36);
const AGENT = `mailtool-${RUN}`;
const CUR_SESSION = "s-cur";

interface SeedBlock {
  blockId: string;
  turnId: string;
  kind: "tool_use" | "tool_result";
  content: unknown;
  blockIndex: number;
}

/**
 * Seed one tool_use + paired tool_result block under `session` so the
 * read-only view at /sessions/<AGENT>/<session> folds them into a single
 * MailToolBlock. The agent's `session_id` stays on CUR_SESSION so these
 * seeds land only in the requested past session's slice.
 */
async function seedToolPair(
  c: Client,
  session: string,
  toolUseId: string,
  toolName: string,
  input: unknown,
  output: string,
): Promise<void> {
  const turn = `${session}-t1`;
  const blocks: SeedBlock[] = [
    {
      blockId: `${AGENT}-${session}-use`,
      turnId: turn,
      kind: "tool_use",
      content: { tool_use_id: toolUseId, name: toolName, input },
      blockIndex: 0,
    },
    {
      blockId: `${AGENT}-${session}-res`,
      turnId: turn,
      kind: "tool_result",
      content: { tool_use_id: toolUseId, text: output, is_error: false },
      blockIndex: 1,
    },
  ];
  for (const b of blocks) {
    await c.query(
      `INSERT INTO blocks
         (id, block_id, turn_id, agent_name, session_id, block_index,
          role, kind, source, content_json, status, streaming, ts)
       VALUES
         (gen_random_uuid()::text, $1, $2, $3, $4, $5,
          'assistant', $6, 'sdk', $7::jsonb, 'complete', false, now())
       ON CONFLICT (block_id) DO NOTHING`,
      [b.blockId, b.turnId, AGENT, session, b.blockIndex, b.kind, JSON.stringify(b.content)],
    );
  }
}

/**
 * Seed a lone tool_use (no tool_result) under `session` — models a tool
 * call still running (status='complete' on the row, but parseBlocks leaves
 * the tool message in `running` until a tool_result lands). Used for the
 * AC#11 running/undefined-input case (no `input` either).
 */
async function seedRunningToolUse(
  c: Client,
  session: string,
  toolUseId: string,
  toolName: string,
  input: unknown,
): Promise<void> {
  await c.query(
    `INSERT INTO blocks
       (id, block_id, turn_id, agent_name, session_id, block_index,
        role, kind, source, content_json, status, streaming, ts)
     VALUES
       (gen_random_uuid()::text, $1, $2, $3, $4, 0,
        'assistant', 'tool_use', 'sdk', $5::jsonb, 'complete', false, now())
     ON CONFLICT (block_id) DO NOTHING`,
    [
      `${AGENT}-${session}-use`,
      `${session}-t1`,
      AGENT,
      session,
      JSON.stringify({ tool_use_id: toolUseId, name: toolName, input }),
    ],
  );
}

async function seedAgentRow(c: Client): Promise<void> {
  const now = new Date();
  await c.query(
    `INSERT INTO agents (name, type, status, session_id, session_count, created_at, updated_at)
       VALUES ($1, 'bare', 'idle', $2, 0, $3, $3)
       ON CONFLICT (name) DO NOTHING`,
    [AGENT, CUR_SESSION, now],
  );
}

const SESSIONS = {
  send: "s-send",
  sendCritical: "s-send-crit",
  read: "s-read",
  readNull: "s-read-null",
  running: "s-running",
  inboxEmpty: "s-inbox-empty",
  readGarbage: "s-read-garbage",
  // FRI-137 AC6: a long mail body that overflows the 200px CollapsibleSection
  // cap, to assert the smart toggle appears for overflowing mail and is
  // absent for the short bodies the other sessions seed.
  sendLong: "s-send-long",
};

// ~60 lines, comfortably past the 200px mail-body cap.
const LONG_MAIL_BODY = Array.from({ length: 60 }, (_, i) => `line ${i} of a very long body`).join(
  "\n",
);

test.beforeAll(async () => {
  const env = loadEnv();
  const c = new Client({ connectionString: env.databaseUrl });
  c.on("error", () => {});
  await c.connect();
  try {
    await seedAgentRow(c);

    // AC#7: mail_send with a full message.
    await seedToolPair(
      c,
      SESSIONS.send,
      "tu_send",
      "mcp__friday-mail__mail_send",
      {
        to: "builder-x",
        subject: "Done",
        type: "message",
        priority: "normal",
        body: "the work is finished",
      },
      "mail sent (id=42)",
    );

    // AC#9: mail_send with critical priority.
    await seedToolPair(
      c,
      SESSIONS.sendCritical,
      "tu_send_crit",
      "mcp__friday-mail__mail_send",
      {
        to: "builder-y",
        subject: "Urgent",
        type: "notification",
        priority: "critical",
        body: "ping",
      },
      "mail sent (id=43)",
    );

    // AC#8 (a): mail_read with a full MailRow in output.
    await seedToolPair(
      c,
      SESSIONS.read,
      "tu_read",
      "mcp__friday-mail__mail_read",
      { id: 7 },
      JSON.stringify({
        id: 7,
        fromAgent: "orchestrator",
        toAgent: AGENT,
        type: "message",
        delivery: "read",
        subject: "Plan",
        threadId: null,
        body: "do X",
        meta: null,
        ts: Date.now(),
        readAt: Date.now(),
        closedAt: null,
        priority: "normal",
      }),
    );

    // AC#8 (b): mail_read whose subject is null.
    await seedToolPair(
      c,
      SESSIONS.readNull,
      "tu_read_null",
      "mcp__friday-mail__mail_read",
      { id: 8 },
      JSON.stringify({
        id: 8,
        fromAgent: "orchestrator",
        toAgent: AGENT,
        type: "message",
        delivery: "read",
        subject: null,
        threadId: null,
        body: "no subject here",
        meta: null,
        ts: Date.now(),
        readAt: Date.now(),
        closedAt: null,
        priority: "normal",
      }),
    );

    // AC#11 (a): running mail_send with NO input and NO output.
    await seedRunningToolUse(
      c,
      SESSIONS.running,
      "tu_running",
      "mcp__friday-mail__mail_send",
      undefined,
    );

    // AC#11 (b): empty mail_inbox.
    await seedToolPair(
      c,
      SESSIONS.inboxEmpty,
      "tu_inbox_empty",
      "mcp__friday-mail__mail_inbox",
      {},
      JSON.stringify([]),
    );

    // AC#11 (c): mail_read whose output is non-JSON garbage.
    await seedToolPair(
      c,
      SESSIONS.readGarbage,
      "tu_read_garbage",
      "mcp__friday-mail__mail_read",
      { id: 9 },
      "not json at all <<<",
    );

    // FRI-137 AC6: a mail_send with a very long body (overflows the 200px
    // body cap) so the smart toggle MUST appear.
    await seedToolPair(
      c,
      SESSIONS.sendLong,
      "tu_send_long",
      "mcp__friday-mail__mail_send",
      {
        to: "builder-z",
        subject: "Long",
        type: "message",
        priority: "normal",
        body: LONG_MAIL_BODY,
      },
      "mail sent (id=44)",
    );
  } finally {
    await c.end();
  }
});

async function openSession(page: Page, env: EnvSnapshot, session: string): Promise<void> {
  await page.context().addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
  await page.goto(`${env.dashboardURL}/sessions/${AGENT}/${session}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page).not.toHaveURL(/\/login/);
  // The read-only past-session view filters Zero blocks by session_id and
  // renders via parseBlocks once the agent's slice has replicated. Wait
  // for the mail card root to mount (generous: zero-cache CVR + replay).
  await expect(page.locator(".mail-tool-block").first()).toBeVisible({ timeout: 25_000 });
}

test.describe("friday-mail tool-call renderer (FRI-135)", () => {
  test("AC7: mail_send renders a preview (to/subject/priority/body), not raw input JSON", async ({
    browser,
  }) => {
    const env = loadEnv();
    const context = await browser.newContext();
    const page = await context.newPage();
    await openSession(page, env, SESSIONS.send);

    const card = page.locator(".mail-tool-block").first();
    // to recipient, subject, body-snippet all present.
    await expect(card).toContainText("builder-x");
    await expect(card).toContainText("Done");
    await expect(card).toContainText("the work is finished");
    // A priority element/badge is present (normal here).
    await expect(card.locator(".mail-meta")).toContainText("priority");
    await expect(card.locator(".mail-meta")).toContainText("normal");

    // The raw input-JSON key form must NOT be visible — the whole point of
    // the renderer is no JSON blob.
    const visible = (await card.textContent()) ?? "";
    expect(visible).not.toContain('"body":');
    expect(visible).not.toContain('"to":');

    await context.close();
  });

  test("AC9: a critical-priority mail_send tints the priority element (.priority-critical)", async ({
    browser,
  }) => {
    const env = loadEnv();
    const context = await browser.newContext();
    const page = await context.newPage();
    await openSession(page, env, SESSIONS.sendCritical);

    const card = page.locator(".mail-tool-block").first();
    const prio = card.locator(".priority-critical");
    await expect(prio).toHaveText("critical");

    // Mirror MailBlock's `.priority-critical { color: var(--status-error) }`:
    // the computed color must equal the document's --status-error.
    const { actual, expected } = await prio.evaluate((el) => {
      const docColor = getComputedStyle(document.documentElement)
        .getPropertyValue("--status-error")
        .trim();
      // Resolve the expected var through a throwaway probe so both sides are
      // in the same rgb() space the browser computes.
      const probe = document.createElement("span");
      probe.style.color = docColor;
      document.body.appendChild(probe);
      const expectedRgb = getComputedStyle(probe).color;
      probe.remove();
      return { actual: getComputedStyle(el).color, expected: expectedRgb };
    });
    expect(actual).toBe(expected);

    await context.close();
  });

  test("AC8: mail_read shows from/subject/body parsed from output, not a JSON dump", async ({
    browser,
  }) => {
    const env = loadEnv();
    const context = await browser.newContext();
    const page = await context.newPage();
    await openSession(page, env, SESSIONS.read);

    const card = page.locator(".mail-tool-block").first();
    await expect(card).toContainText("orchestrator");
    await expect(card).toContainText("Plan");
    await expect(card).toContainText("do X");

    const visible = (await card.textContent()) ?? "";
    expect(visible).not.toContain('"fromAgent":');

    await context.close();
  });

  test('AC8: a null-subject mail_read renders without the literal string "null"', async ({
    browser,
  }) => {
    const env = loadEnv();
    const context = await browser.newContext();
    const page = await context.newPage();
    await openSession(page, env, SESSIONS.readNull);

    const card = page.locator(".mail-tool-block").first();
    await expect(card).toContainText("no subject here");
    // The meta block must not surface the JS string "null" as the subject.
    const metaText = (await card.locator(".mail-meta").textContent()) ?? "";
    expect(metaText).not.toContain("null");

    await context.close();
  });

  test("AC11: running mail_send (no input) shows headline + running badge, no crash", async ({
    browser,
  }) => {
    const env = loadEnv();
    const context = await browser.newContext();
    const page = await context.newPage();

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    await openSession(page, env, SESSIONS.running);

    const card = page.locator(".mail-tool-block").first();
    // Headline still renders. With no `input`, synthesizeHeadline returns
    // undefined, so MailToolBlock falls back to the per-tool default
    // ("Sending mail" for mail_send).
    await expect(card.locator(".mail-tool-headline")).toContainText("Sending mail");
    await expect(card.locator(".badge")).toContainText("running");

    // No thrown "Cannot read properties of undefined" from the undefined input.
    const realErrors = consoleErrors.filter(
      (e) => !e.startsWith("Failed to load resource:") && e.includes("undefined"),
    );
    expect(realErrors, `Unexpected undefined-access errors: ${realErrors.join("\n")}`).toEqual([]);

    await context.close();
  });

  test("AC11: empty mail_inbox renders an inbox-empty message", async ({ browser }) => {
    const env = loadEnv();
    const context = await browser.newContext();
    const page = await context.newPage();
    await openSession(page, env, SESSIONS.inboxEmpty);

    const card = page.locator(".mail-tool-block").first();
    await expect(card).toContainText("Inbox empty");

    await context.close();
  });

  test("AC11: a non-JSON mail_read output falls back to showing the raw text", async ({
    browser,
  }) => {
    const env = loadEnv();
    const context = await browser.newContext();
    const page = await context.newPage();
    await openSession(page, env, SESSIONS.readGarbage);

    const card = page.locator(".mail-tool-block").first();
    // Parse-failure fallback: the raw output text is shown verbatim.
    await expect(card).toContainText("not json at all <<<");

    await context.close();
  });

  test("FRI-137 AC6: a short mail body has NO toggle; a long one keeps a working toggle", async ({
    browser,
  }) => {
    const env = loadEnv();

    // Short body (SESSIONS.send: "the work is finished") fits the 200px cap →
    // the CollapsibleSection renders no disclosure control.
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await openSession(page, env, SESSIONS.send);
      const card = page.locator(".mail-tool-block").first();
      await expect(card).toContainText("the work is finished");
      await expect(card.locator("[aria-expanded]")).toHaveCount(0);
      await context.close();
    }

    // Long body overflows the cap → exactly one working +/− toggle.
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await openSession(page, env, SESSIONS.sendLong);
      const card = page.locator(".mail-tool-block").first();
      const toggle = card.locator("button.collapsible-toggle").first();
      await expect(toggle).toHaveAttribute("aria-expanded", /true|false/);
      const glyph = (await toggle.locator(".glyph").textContent())?.trim();
      expect(["+", "−"]).toContain(glyph);
      const before = await toggle.getAttribute("aria-expanded");
      await toggle.click();
      await expect(toggle).not.toHaveAttribute("aria-expanded", before ?? "");
      await context.close();
    }
  });
});
