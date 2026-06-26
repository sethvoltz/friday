/**
 * ADR-049 — typed intent seam contract tests.
 *
 * These are the cross-boundary tests the seam previously lacked. They pin the
 * agreement that used to live only in prose idempotency comments + duplicated
 * string literals across the `@friday/shared` mutator ↔ `services/daemon`
 * listener package boundary:
 *
 *   1. content_json view: `buildUserMessageContent` (mutator side) and
 *      `parseUserMessageContent` (listener side) agree on the `{ text,
 *      attachments? }` shape — including the exact malformed/empty behavior
 *      the dispatch + resume listeners depended on.
 *   2. token ↔ DB CHECK: every centralized `INTENT_STATUS` value is a member
 *      of its table's CHECK constraint set, read live from the Drizzle schema.
 *      A token rename that desyncs from the CHECK (a runtime CHECK violation
 *      in prod) fails here instead.
 *   3. mutator → token: each side-effect mutator writes the centralized token
 *      (not a re-spelled literal) and the columns the listener's precondition
 *      reads — catching the §2 drift class where a postcondition silently
 *      diverges from what the listener expects.
 */

import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";
import {
  INTENT_STATUS,
  INTENT_STATUS_TABLE,
  buildUserMessageContent,
  parseUserMessageContent,
  type IntentStatus,
} from "./intents.js";
import {
  createMutators,
  type AbortTurnArgs,
  type ArchiveAgentArgs,
  type CancelQueuedArgs,
  type CreateMemoryEntryArgs,
  type CreateScheduleArgs,
  type ResumeTurnArgs,
  type SendUserMessageArgs,
} from "./mutators.js";

/* ------------------------------------------------------------------ *
 * 1. content_json view: build ↔ parse agreement
 * ------------------------------------------------------------------ */

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("buildUserMessageContent", () => {
  it("omits the attachments key entirely when there are none", () => {
    expect(buildUserMessageContent("hello")).toEqual({ text: "hello" });
    expect("attachments" in buildUserMessageContent("hello")).toBe(false);
  });

  it("omits the attachments key for an empty array (matches the mutator's prior guard)", () => {
    expect(buildUserMessageContent("hello", [])).toEqual({ text: "hello" });
    expect("attachments" in buildUserMessageContent("hello", [])).toBe(false);
  });

  it("includes attachments when present", () => {
    const att = [{ sha256: SHA_A, filename: "a.png", mime: "image/png" }];
    expect(buildUserMessageContent("hi", att)).toEqual({ text: "hi", attachments: att });
  });
});

describe("parseUserMessageContent", () => {
  it("round-trips a built payload back to the same fields", () => {
    const att = [
      { sha256: SHA_A, filename: "a.png", mime: "image/png" },
      { sha256: SHA_B, filename: "b.pdf", mime: "application/pdf" },
    ];
    const built = buildUserMessageContent("the prompt", att);
    const parsed = parseUserMessageContent(JSON.stringify(built));
    expect(parsed).toEqual({ ok: true, content: { text: "the prompt", attachments: att } });
  });

  it("parses text-only content with no attachments key", () => {
    const parsed = parseUserMessageContent(JSON.stringify({ text: "just text" }));
    expect(parsed.ok).toBe(true);
    expect(parsed.content).toEqual({ text: "just text" });
    expect("attachments" in parsed.content).toBe(false);
  });

  it("reports ok:false with empty text on syntactically malformed JSON", () => {
    // ok:false is the parser's corrupt discriminator. (Which listener BRANCH
    // this drives — dispatch forks-empty, resume bails-corrupt — is pinned at
    // the daemon layer in dispatch-listener.test.ts / resume-listener.test.ts,
    // not here; this test owns only the parser's return value.)
    expect(parseUserMessageContent("{not json")).toEqual({ ok: false, content: { text: "" } });
  });

  it("reports ok:false on a JSON null (property access on the primitive throws, as in the old hand-parse)", () => {
    expect(parseUserMessageContent("null")).toEqual({ ok: false, content: { text: "" } });
  });

  it("stays ok:true (NOT corrupt) for a non-object primitive — number, string, array", () => {
    // The original hand-parse only treated a THROW as corrupt; a parsed
    // number/string/array did not throw on `parsed.text`, so it fell through
    // with text="". Adding a `typeof parsed !== 'object'` guard here would flip
    // resume from its empty-text bail to its content-corrupt bail (a behavior
    // change), so this pins ok:true for those inputs.
    expect(parseUserMessageContent("42")).toEqual({ ok: true, content: { text: "" } });
    expect(parseUserMessageContent('"foo"')).toEqual({ ok: true, content: { text: "" } });
    expect(parseUserMessageContent("[1,2]")).toEqual({ ok: true, content: { text: "" } });
  });

  it("coerces a non-string text to empty string but stays ok:true", () => {
    const parsed = parseUserMessageContent(JSON.stringify({ text: 42 }));
    expect(parsed).toEqual({ ok: true, content: { text: "" } });
  });

  it("drops attachments whose sha256 fails the 64-hex guard, keeps valid ones", () => {
    const raw = JSON.stringify({
      text: "x",
      attachments: [
        { sha256: SHA_A, filename: "ok.png", mime: "image/png" }, // valid
        { sha256: "tooshort", filename: "bad.png", mime: "image/png" }, // bad sha
        { sha256: "G".repeat(64), filename: "nonhex.png", mime: "image/png" }, // non-hex
        null, // null entry
        { filename: "no-sha.png", mime: "image/png" }, // missing sha256
        "not-an-object",
      ],
    });
    const parsed = parseUserMessageContent(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.content.attachments).toEqual([
      { sha256: SHA_A, filename: "ok.png", mime: "image/png" },
    ]);
  });

  it("yields an empty attachments array (not undefined) when attachments is present but all-invalid", () => {
    // Mirrors the old hand-parse: `Array.isArray` was true, the filter emptied
    // it — so the key is present as []. The dispatch/resume call sites guard on
    // `.length > 0` before forwarding, so [] and undefined behave identically.
    const parsed = parseUserMessageContent(JSON.stringify({ text: "x", attachments: [null] }));
    expect(parsed.content.attachments).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. token ↔ DB CHECK constraint agreement
 * ------------------------------------------------------------------ */

const TABLE_BY_NAME = {
  blocks: schema.blocks,
  memory_entries: schema.memoryEntries,
  schedules: schema.schedules,
  agents: schema.agents,
} as const;

/** Read a table's status CHECK constraint value set live from the Drizzle
 *  schema (the source of truth that generates the migration). */
function statusCheckValues(table: keyof typeof TABLE_BY_NAME): Set<string> {
  const dialect = new PgDialect();
  const cfg = getTableConfig(TABLE_BY_NAME[table]);
  const check = cfg.checks.find((c) => c.name.endsWith("status_check"));
  if (!check) throw new Error(`no status_check on ${table}`);
  const sql = dialect.sqlToQuery(check.value).sql;
  return new Set([...sql.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

describe("INTENT_STATUS ↔ DB CHECK constraint", () => {
  it("maps every token to a table in INTENT_STATUS_TABLE", () => {
    for (const value of Object.values(INTENT_STATUS)) {
      expect(INTENT_STATUS_TABLE[value as IntentStatus]).toBeTruthy();
    }
  });

  it.each(Object.entries(INTENT_STATUS))(
    "token %s=%s is a member of its table's status CHECK set",
    (_key, value) => {
      const table = INTENT_STATUS_TABLE[value as IntentStatus];
      const allowed = statusCheckValues(table);
      expect(allowed.has(value)).toBe(true);
    },
  );

  it("the daemon's transient block tokens are all present in blocks_status_check", () => {
    // Spelled-out backstop for the parametrized case above: a future edit that
    // drops e.g. resume_requested from the CHECK must fail loudly.
    const allowed = statusCheckValues("blocks");
    for (const t of [
      INTENT_STATUS.pending,
      INTENT_STATUS.abortRequested,
      INTENT_STATUS.cancelRequested,
      INTENT_STATUS.resumeRequested,
    ]) {
      expect(allowed.has(t)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. mutator → intent token contract
 * ------------------------------------------------------------------ */

interface CapturedTx {
  blocksInserts: Array<{
    role: string;
    source: string | null;
    status: string;
    content_json: unknown;
  }>;
  blocksUpdates: Array<{ id: string; status: string }>;
  agentUpdates: Array<{ name: string; status: string }>;
  scheduleInserts: Array<{ name: string; status: string }>;
  memoryInserts: Array<{ id: string; status: string }>;
}

function makeTx(): {
  tx: Parameters<ReturnType<typeof createMutators>["sendUserMessage"]>[0];
  captured: CapturedTx;
} {
  const captured: CapturedTx = {
    blocksInserts: [],
    blocksUpdates: [],
    agentUpdates: [],
    scheduleInserts: [],
    memoryInserts: [],
  };
  const tx = {
    mutate: {
      blocks: {
        insert: vi.fn(async (r: CapturedTx["blocksInserts"][number]) => {
          captured.blocksInserts.push(r);
        }),
        update: vi.fn(async (r: CapturedTx["blocksUpdates"][number]) => {
          captured.blocksUpdates.push(r);
        }),
      },
      agents: {
        update: vi.fn(async (r: CapturedTx["agentUpdates"][number]) => {
          captured.agentUpdates.push(r);
        }),
      },
      schedules: {
        insert: vi.fn(async (r: CapturedTx["scheduleInserts"][number]) => {
          captured.scheduleInserts.push(r);
        }),
      },
      memory_entries: {
        insert: vi.fn(async (r: CapturedTx["memoryInserts"][number]) => {
          captured.memoryInserts.push(r);
        }),
      },
    },
  } as unknown as Parameters<ReturnType<typeof createMutators>["sendUserMessage"]>[0];
  return { tx, captured };
}

describe("mutator → intent token contract", () => {
  it("sendUserMessage writes status=pending, the listener's role/source shape, and parseable content", async () => {
    const { tx, captured } = makeTx();
    const att = [{ sha256: SHA_A, filename: "a.png", mime: "image/png" }];
    const args: SendUserMessageArgs = {
      id: "blk-1",
      turnId: "t_1",
      agentName: "friday",
      text: "hello there",
      attachments: att,
      ts: 1_700_000_000_000,
    };
    await createMutators().sendUserMessage(tx, args);

    expect(captured.blocksInserts).toHaveLength(1);
    const row = captured.blocksInserts[0];
    // Token the dispatch listener's precondition (`status !== pending`) keys on.
    expect(row.status).toBe(INTENT_STATUS.pending);
    // Shape guard the listener enforces (dispatch-listener.ts role/source check).
    expect(row.role).toBe("user");
    expect(row.source).toBe("user_chat");
    // The listener re-parses content_json via parseUserMessageContent — assert
    // the mutator's write survives that exact round-trip.
    const parsed = parseUserMessageContent(JSON.stringify(row.content_json));
    expect(parsed).toEqual({ ok: true, content: { text: "hello there", attachments: att } });
  });

  it("abortTurn writes only {id, status=abort_requested} (other columns preserved for the listener)", async () => {
    const { tx, captured } = makeTx();
    const args: AbortTurnArgs = { id: "blk-1", ts: 1 };
    await createMutators().abortTurn(tx, args);
    expect(captured.blocksUpdates).toEqual([{ id: "blk-1", status: INTENT_STATUS.abortRequested }]);
  });

  it("cancelQueued writes only {id, status=cancel_requested}", async () => {
    const { tx, captured } = makeTx();
    const args: CancelQueuedArgs = { id: "blk-1", ts: 1 };
    await createMutators().cancelQueued(tx, args);
    expect(captured.blocksUpdates).toEqual([
      { id: "blk-1", status: INTENT_STATUS.cancelRequested },
    ]);
  });

  it("resumeTurn writes only {id, status=resume_requested}", async () => {
    const { tx, captured } = makeTx();
    const args: ResumeTurnArgs = { id: "blk-1", ts: 1 };
    await createMutators().resumeTurn(tx, args);
    expect(captured.blocksUpdates).toEqual([
      { id: "blk-1", status: INTENT_STATUS.resumeRequested },
    ]);
  });

  it("archiveAgent writes status=archive_requested on the agents row", async () => {
    const { tx, captured } = makeTx();
    const args: ArchiveAgentArgs = { name: "builder-x", reason: "completed", ts: 1 };
    await createMutators().archiveAgent(tx, args);
    expect(captured.agentUpdates).toHaveLength(1);
    expect(captured.agentUpdates[0]).toMatchObject({
      name: "builder-x",
      status: INTENT_STATUS.archiveRequested,
    });
  });

  it("createSchedule writes status=pending_register on the schedules row", async () => {
    const { tx, captured } = makeTx();
    const args: CreateScheduleArgs = {
      name: "daily",
      cron: "0 9 * * *",
      taskPrompt: "do the thing",
      ts: 1,
    };
    await createMutators().createSchedule(tx, args);
    expect(captured.scheduleInserts).toHaveLength(1);
    expect(captured.scheduleInserts[0]).toMatchObject({
      name: "daily",
      status: INTENT_STATUS.pendingRegister,
    });
  });

  it("createMemoryEntry writes status=pending_file on the memory_entries row", async () => {
    const { tx, captured } = makeTx();
    const args: CreateMemoryEntryArgs = {
      id: "mem-1",
      title: "T",
      content: "C",
      tags: ["a"],
      createdBy: "friday",
      ts: 1,
    };
    await createMutators().createMemoryEntry(tx, args);
    expect(captured.memoryInserts).toHaveLength(1);
    expect(captured.memoryInserts[0]).toMatchObject({
      id: "mem-1",
      status: INTENT_STATUS.pendingFile,
    });
  });
});
