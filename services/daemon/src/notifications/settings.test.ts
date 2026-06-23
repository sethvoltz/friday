/**
 * FRI-142 / ADR-048 — `readNotifySettings` fail-open defaults.
 *
 * The bug class this owns: a MISSING settings row (or a row with NULL notify
 * columns) must NEVER silence notifications — it must fall back to the fail-OPEN
 * defaults (empty policy ⇒ DEFAULT_NOTIFY_POLICY downstream, no DND window,
 * critical-bypass ON). Tested at the read layer with a stateful in-memory
 * `getDb()` mock (the IO boundary) — the NULL-coalescing + missing-row branches
 * are pinned to EXACT values, so deleting any `?? <default>` fallback or the
 * `if (!row)` guard from settings.ts goes red here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyPolicy } from "@friday/shared";

// ---- The single in-memory settings row the mocked getDb() reads. -----------
// `null` models "no row at all" (the migration-didn't-seed / fresh case);
// otherwise it is the one `settings` row the SINGLETON query returns.
interface SettingsRow {
  id: string;
  notifyPolicy: NotifyPolicy | null;
  dndStart: string | null;
  dndEnd: string | null;
  criticalBypassDnd: boolean | null;
}

let settingsRow: SettingsRow | null = null;

/**
 * Chainable mock matching the exact call shape readNotifySettings uses:
 *   db.select().from(settings).where(eq(settings.id, "singleton")).limit(1)
 * Returns the single row (or [] when absent).
 */
function makeDb() {
  return {
    select: () => ({
      from: (_table: unknown) => ({
        where: (_pred: unknown) => ({
          limit: (_n: number) => Promise.resolve(settingsRow ? [settingsRow] : []),
        }),
      }),
    }),
  };
}

vi.mock("@friday/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@friday/shared")>();
  return {
    ...actual,
    getDb: () => makeDb(),
    schema: {
      ...actual.schema,
      settings: { id: { key: "id" } },
    },
  };
});

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: { key: string }, val: unknown) => ({ op: "eq" as const, col: col.key, val }),
  };
});

import { readNotifySettings } from "./settings.js";

beforeEach(() => {
  settingsRow = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("readNotifySettings — fail-open defaults", () => {
  it("no settings row ⇒ fail-OPEN defaults (a missing row never silences notifications)", async () => {
    settingsRow = null;
    expect(await readNotifySettings()).toEqual({
      policy: {},
      dndStart: null,
      dndEnd: null,
      criticalBypassDnd: true,
    });
  });

  it("a row with ALL notify columns NULL ⇒ coalesces to the same fail-open defaults", async () => {
    settingsRow = {
      id: "singleton",
      notifyPolicy: null,
      dndStart: null,
      dndEnd: null,
      criticalBypassDnd: null,
    };
    expect(await readNotifySettings()).toEqual({
      policy: {},
      dndStart: null,
      dndEnd: null,
      criticalBypassDnd: true,
    });
  });

  it("a fully-populated row passes every value through verbatim", async () => {
    const policy: NotifyPolicy = {
      builder_archive: { toast: "never", push: "always" },
      mail_delivered: { push: "absent_only" },
    };
    settingsRow = {
      id: "singleton",
      notifyPolicy: policy,
      dndStart: "22:00",
      dndEnd: "07:00",
      criticalBypassDnd: false,
    };
    expect(await readNotifySettings()).toEqual({
      policy,
      dndStart: "22:00",
      dndEnd: "07:00",
      criticalBypassDnd: false,
    });
  });
});
