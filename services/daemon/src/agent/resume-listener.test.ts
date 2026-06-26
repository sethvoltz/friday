/**
 * FRI-123 — block resumeTurn LISTEN trigger + handler-guard tests.
 *
 * Trigger contract (mirrors abort-listener.test.ts shape):
 *   - Fires NOTIFY `friday_resume_requested` on UPDATE that
 *     transitions blocks.status TO 'resume_requested'.
 *   - Does NOT fire on the daemon's flip-back UPDATE to 'complete'
 *     (handler-reentry safety).
 *   - Does NOT fire on common lifecycle UPDATEs that don't touch
 *     status (other-field bumps must not spam the channel).
 *   - AFTER UPDATE only — INSERTs at 'resume_requested' don't fire.
 *
 * Handler-guard tests exercise `_processResumeRequestedRow` with
 * `vi.mock`-hoisted stubs for the lifecycle/registry/skills deps so
 * the test doesn't fork workers. Each test asserts the row's final
 * status + the dispatchTurn call args + the buildDispatchPrompt
 * intent shape (catches the FRI-123-review regressions: attachments
 * dropped, skill invocation dropped).
 *
 * Static `vi.mock` (not `vi.doMock` + `vi.resetModules`) so
 * `@friday/shared`'s module-level Postgres pool doesn't get rebound
 * mid-file — `resetModules` would spawn a second pool that leaks
 * until the test DB is dropped, surfacing as a FATAL `57P01`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, getDb, schema, type TestDbHandle, newTestClient } from "@friday/shared";
import { eq, sql } from "drizzle-orm";
import { logger } from "../log.js";

vi.mock("./registry.js", () => ({
  getAgent: vi.fn(),
  workingDirectoryFor: vi.fn(async () => "/tmp/cwd"),
}));
vi.mock("./lifecycle.js", () => ({
  dispatchTurn: vi.fn(),
  findAgentByTurnId: vi.fn(() => null),
  peekLiveWorker: vi.fn(() => null),
}));
vi.mock("../prompts/build-dispatch-prompt.js", () => ({
  buildDispatchPrompt: vi.fn(async () => ({
    systemPrompt: "system-stub",
    body: "body-stub",
    allowedToolsOverride: undefined,
  })),
}));
vi.mock("../skills/match.js", () => ({
  matchSkillInvocation: vi.fn(() => null),
}));

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "resume_listener" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  vi.clearAllMocks();
});

async function insertUserBlock(blockId: string, status: string = "complete"): Promise<void> {
  const db = getDb();
  await db.insert(schema.blocks).values({
    blockId,
    turnId: `turn-${blockId}`,
    agentName: "test-agent",
    sessionId: "test-session",
    messageId: null,
    blockIndex: 0,
    role: "user",
    kind: "text",
    source: "user_chat",
    contentJson: { text: "the original prompt" },
    status,
    streaming: false,
    originMutationId: null,
    ts: new Date(),
  });
}

/** Seed an assistant `kind='error'` block for the given user
 *  block's turn — required for the new no-error-block guard to
 *  let resume proceed. Mirrors the shape the daemon writes for a
 *  turn that errored out. */
async function insertErrorBlock(forUserBlockId: string): Promise<void> {
  const db = getDb();
  await db.insert(schema.blocks).values({
    blockId: `err-${forUserBlockId}`,
    turnId: `turn-${forUserBlockId}`,
    agentName: "test-agent",
    sessionId: "test-session",
    messageId: null,
    blockIndex: 1,
    role: "assistant",
    kind: "error",
    source: null,
    contentJson: { text: "boom", code: "api_error" },
    status: "error",
    streaming: false,
    originMutationId: null,
    ts: new Date(),
  });
}

async function insertUserBlockWithContent(
  blockId: string,
  content: Record<string, unknown>,
  status: string = "resume_requested",
): Promise<void> {
  const db = getDb();
  await db.insert(schema.blocks).values({
    blockId,
    turnId: `turn-${blockId}`,
    agentName: "test-agent",
    sessionId: "test-session",
    messageId: null,
    blockIndex: 0,
    role: "user",
    kind: "text",
    source: "user_chat",
    contentJson: content,
    status,
    streaming: false,
    originMutationId: null,
    ts: new Date(),
  });
}

describe("Postgres trigger: friday_block_resume_notify_trigger", () => {
  it("fires NOTIFY when status transitions to 'resume_requested' and carries block_id as payload", async () => {
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertUserBlock("blk-resume-1");

      const received: Array<{ channel: string; payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ channel: msg.channel, payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_resume_requested");

      const db = getDb();
      await db.update(schema.blocks).set({ status: "resume_requested" });

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1);
          expect(received[0]!.channel).toBe("friday_resume_requested");
          expect(received[0]!.payload).toBe("blk-resume-1");
        },
        { timeout: 5000, interval: 25 },
      );
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY when the daemon flips the row back to 'complete' (handler-reentry safety)", async () => {
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertUserBlock("blk-resume-2", "resume_requested");
      await client.query("LISTEN friday_resume_requested");
      // negative-space: drain any buffered notification before attaching
      // our handler so the assertion below isn't polluted.
      await new Promise((r) => setTimeout(r, 250));

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));

      const db = getDb();
      await db.update(schema.blocks).set({ status: "complete" });

      // negative-space: trigger predicate excludes flips to 'complete' —
      // a bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY on common lifecycle transitions (other-field UPDATEs)", async () => {
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertUserBlock("blk-resume-3");

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_resume_requested");

      const db = getDb();
      await db.update(schema.blocks).set({ blockIndex: 1 });

      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("AFTER UPDATE only — INSERT at status='resume_requested' doesn't fire", async () => {
    const client = newTestClient({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_resume_requested");

      await insertUserBlock("blk-resume-insert", "resume_requested");

      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});

describe("processResumeRequestedRow handler guards", () => {
  async function getStatus(blockId: string): Promise<string | null> {
    const db = getDb();
    const rows = await db
      .select({ status: schema.blocks.status })
      .from(schema.blocks)
      .where(eq(schema.blocks.blockId, blockId));
    return rows[0]?.status ?? null;
  }

  function stubAgent(name: string): {
    name: string;
    type: "orchestrator";
    status: "idle";
    createdAt: string;
    updatedAt: string;
  } {
    return {
      name,
      type: "orchestrator",
      status: "idle",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  it("no-op when the row was deleted between NOTIFY and handler", async () => {
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(stubAgent("test-agent"));
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);

    await _processResumeRequestedRow("blk-missing");
    expect(lifecycle.dispatchTurn).not.toHaveBeenCalled();
  });

  it("no-op when status has already moved on (idempotent re-run after claim)", async () => {
    await insertUserBlock("blk-resume-idem", "complete");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    await _processResumeRequestedRow("blk-resume-idem");
    expect(lifecycle.dispatchTurn).not.toHaveBeenCalled();
    expect(await getStatus("blk-resume-idem")).toBe("complete");
  });

  it("flips back without dispatching when the turn has no error block (parent-turn-error guard)", async () => {
    // FRI-123 review #5: stray mutator calls re-firing arbitrary
    // historical user prompts are blocked server-side by requiring
    // an assistant kind='error' block in the same turn.
    await insertUserBlock("blk-resume-noerror", "resume_requested");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(stubAgent("test-agent"));
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);

    await _processResumeRequestedRow("blk-resume-noerror");
    expect(lifecycle.dispatchTurn).not.toHaveBeenCalled();
    expect(await getStatus("blk-resume-noerror")).toBe("complete");
  });

  it("flips back without dispatching when the agent doesn't exist (no-agent guard)", async () => {
    await insertUserBlock("blk-resume-noagent", "resume_requested");
    await insertErrorBlock("blk-resume-noagent");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(null);
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);

    await _processResumeRequestedRow("blk-resume-noagent");
    expect(lifecycle.dispatchTurn).not.toHaveBeenCalled();
    expect(await getStatus("blk-resume-noagent")).toBe("complete");
  });

  it("does NOT flip back when a turn is already in flight (soft retry — leaves row marked)", async () => {
    // FRI-123 review #3+#4: the in-flight guard preserves the
    // resume_requested status so a future NOTIFY (next click or
    // boot scan) re-processes the row once the busy condition
    // clears. Flipping back here silently loses the user's click.
    await insertUserBlock("blk-resume-inflight", "resume_requested");
    await insertErrorBlock("blk-resume-inflight");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(stubAgent("test-agent"));
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue("test-agent");

    await _processResumeRequestedRow("blk-resume-inflight");
    expect(lifecycle.dispatchTurn).not.toHaveBeenCalled();
    // Row stays marked — soft retry semantics.
    expect(await getStatus("blk-resume-inflight")).toBe("resume_requested");
  });

  it("does NOT flip back when peekLiveWorker reports the agent as working (soft retry)", async () => {
    await insertUserBlock("blk-resume-busy", "resume_requested");
    await insertErrorBlock("blk-resume-busy");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(stubAgent("test-agent"));
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);
    vi.mocked(lifecycle.peekLiveWorker).mockReturnValue({
      status: "working",
    } as ReturnType<typeof lifecycle.peekLiveWorker>);

    await _processResumeRequestedRow("blk-resume-busy");
    expect(lifecycle.dispatchTurn).not.toHaveBeenCalled();
    // Row stays marked — soft retry semantics.
    expect(await getStatus("blk-resume-busy")).toBe("resume_requested");
  });

  it("atomic claim — concurrent handlers result in exactly one dispatch", async () => {
    // FRI-123 review #3: the UPDATE…WHERE status='resume_requested'
    // claim ensures only one of N concurrent NOTIFY handlers wins
    // and dispatches; the others find rowCount=0 and bail.
    await insertUserBlock("blk-resume-race", "resume_requested");
    await insertErrorBlock("blk-resume-race");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(stubAgent("test-agent"));
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);
    vi.mocked(lifecycle.peekLiveWorker).mockReturnValue({
      status: "idle",
    } as ReturnType<typeof lifecycle.peekLiveWorker>);

    // Fire three concurrent handler invocations for the same blockId.
    await Promise.all([
      _processResumeRequestedRow("blk-resume-race"),
      _processResumeRequestedRow("blk-resume-race"),
      _processResumeRequestedRow("blk-resume-race"),
    ]);

    expect(lifecycle.dispatchTurn).toHaveBeenCalledTimes(1);
    expect(await getStatus("blk-resume-race")).toBe("complete");
  });

  it("happy path — dispatches re-using the original turn_id with the right intent shape", async () => {
    await insertUserBlock("blk-resume-ok", "resume_requested");
    await insertErrorBlock("blk-resume-ok");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const buildPrompt = await import("../prompts/build-dispatch-prompt.js");
    const skills = await import("../skills/match.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(stubAgent("test-agent"));
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);
    vi.mocked(lifecycle.peekLiveWorker).mockReturnValue({
      status: "idle",
    } as ReturnType<typeof lifecycle.peekLiveWorker>);
    vi.mocked(skills.matchSkillInvocation).mockReturnValue(null);

    await _processResumeRequestedRow("blk-resume-ok");

    // Skill detection ran against the parsed userText.
    expect(skills.matchSkillInvocation).toHaveBeenCalledWith("the original prompt", "orchestrator");
    // buildDispatchPrompt got the right intent — kind=user_chat,
    // userText=<original prompt>, no skillMatch (regression check
    // for FRI-123 review #2).
    expect(buildPrompt.buildDispatchPrompt).toHaveBeenCalledTimes(1);
    const promptArgs = vi.mocked(buildPrompt.buildDispatchPrompt).mock.calls[0]!;
    expect(promptArgs[0]).toEqual(expect.objectContaining({ name: "test-agent" }));
    expect(promptArgs[1]).toEqual({
      kind: "user_chat",
      userText: "the original prompt",
      skillMatch: undefined,
    });
    // dispatchTurn fired with FRI-12 visual-grouping contract
    // (reused turnId) + the system/body from buildDispatchPrompt.
    expect(lifecycle.dispatchTurn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(lifecycle.dispatchTurn).mock.calls[0]?.[0] as {
      agentName: string;
      options: {
        turnId: string;
        systemPrompt: string;
        prompt: string;
        attachments?: unknown;
      };
    };
    expect(call.agentName).toBe("test-agent");
    expect(call.options.turnId).toBe("turn-blk-resume-ok");
    expect(call.options.systemPrompt).toBe("system-stub");
    expect(call.options.prompt).toBe("body-stub");
    // No attachments on the original row → undefined here.
    expect(call.options.attachments).toBeUndefined();
    expect(await getStatus("blk-resume-ok")).toBe("complete");
  });

  it("forwards attachments from content_json to dispatchTurn (FRI-123 review #1)", async () => {
    // Regression: the original resume route + the initial resume-
    // listener silently dropped attachments. A user who sent an
    // image, errored, then clicked Resume must get the image
    // re-dispatched too.
    const sha = "a".repeat(64);
    await insertUserBlockWithContent("blk-resume-att", {
      text: "look at this",
      attachments: [{ sha256: sha, filename: "x.png", mime: "image/png" }],
    });
    await insertErrorBlock("blk-resume-att");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(stubAgent("test-agent"));
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);
    vi.mocked(lifecycle.peekLiveWorker).mockReturnValue({
      status: "idle",
    } as ReturnType<typeof lifecycle.peekLiveWorker>);

    await _processResumeRequestedRow("blk-resume-att");

    expect(lifecycle.dispatchTurn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(lifecycle.dispatchTurn).mock.calls[0]?.[0] as {
      options: { attachments?: Array<{ sha256: string; filename: string; mime: string }> };
    };
    expect(call.options.attachments).toEqual([
      { sha256: sha, filename: "x.png", mime: "image/png" },
    ]);
  });

  it("filters attachments with malformed sha256 (defense in depth)", async () => {
    const goodSha = "b".repeat(64);
    await insertUserBlockWithContent("blk-resume-att-mix", {
      text: "mixed bag",
      attachments: [
        { sha256: goodSha, filename: "good.png", mime: "image/png" },
        { sha256: "not-hex", filename: "bad.png", mime: "image/png" },
        { sha256: "tooshort", filename: "bad2.png", mime: "image/png" },
      ],
    });
    await insertErrorBlock("blk-resume-att-mix");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(stubAgent("test-agent"));
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);
    vi.mocked(lifecycle.peekLiveWorker).mockReturnValue({
      status: "idle",
    } as ReturnType<typeof lifecycle.peekLiveWorker>);

    await _processResumeRequestedRow("blk-resume-att-mix");

    const call = vi.mocked(lifecycle.dispatchTurn).mock.calls[0]?.[0] as {
      options: { attachments?: Array<{ sha256: string }> };
    };
    expect(call.options.attachments).toEqual([
      { sha256: goodSha, filename: "good.png", mime: "image/png" },
    ]);
  });

  it("threads skill invocation through to buildDispatchPrompt (FRI-123 review #2)", async () => {
    // Regression: the initial resume-listener didn't call
    // matchSkillInvocation, so `/research foo` retries went out
    // as literal `/research foo` body with no skillContextHook
    // append + no allowedToolsOverride.
    await insertUserBlockWithContent("blk-resume-skill", { text: "/research foo bar" });
    await insertErrorBlock("blk-resume-skill");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const buildPrompt = await import("../prompts/build-dispatch-prompt.js");
    const skills = await import("../skills/match.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(stubAgent("test-agent"));
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);
    vi.mocked(lifecycle.peekLiveWorker).mockReturnValue({
      status: "idle",
    } as ReturnType<typeof lifecycle.peekLiveWorker>);
    const fakeSkill = {
      name: "research",
      description: "test",
      agents: null,
      allowedTools: ["Bash"],
      autoInvoke: false,
      body: "skill body",
      source: "user" as const,
      filePath: "/tmp/research.md",
    };
    vi.mocked(skills.matchSkillInvocation).mockReturnValue({
      skill: fakeSkill,
      userText: "foo bar",
    });

    await _processResumeRequestedRow("blk-resume-skill");

    expect(skills.matchSkillInvocation).toHaveBeenCalledWith("/research foo bar", "orchestrator");
    // The matched skill's userText (args stripped of slash command)
    // + the skillMatch object must thread into buildDispatchPrompt.
    const promptArgs = vi.mocked(buildPrompt.buildDispatchPrompt).mock.calls[0]!;
    expect(promptArgs[1]).toEqual({
      kind: "user_chat",
      userText: "foo bar",
      skillMatch: { skill: fakeSkill, userText: "foo bar" },
    });
  });

  it("flips back via the EMPTY-TEXT guard when text is a non-string (parser stays ok:true)", async () => {
    // `{ text: 42 }` is valid JSON with a non-string text. parseUserMessageContent
    // returns ok:TRUE with text="" (no throw), so this does NOT hit the
    // content-corrupt branch — it falls through to the empty-text guard. Both
    // bail terminal-no-retry and flip to 'complete'; the DISTINGUISHING signal
    // is the log event, so assert on it (getStatus alone can't tell the two
    // branches apart). The genuine content-corrupt branch is the next test.
    await insertUserBlockWithContent("blk-resume-emptytext", { text: 42 });
    await insertErrorBlock("blk-resume-emptytext");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(stubAgent("test-agent"));
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);
    vi.mocked(lifecycle.peekLiveWorker).mockReturnValue({
      status: "idle",
    } as ReturnType<typeof lifecycle.peekLiveWorker>);
    const logSpy = vi.spyOn(logger, "log");

    await _processResumeRequestedRow("blk-resume-emptytext");

    expect(lifecycle.dispatchTurn).not.toHaveBeenCalled();
    expect(await getStatus("blk-resume-emptytext")).toBe("complete");
    const events = logSpy.mock.calls.map((c) => c[1]);
    expect(events).toContain("block.resume.skip.empty-text");
    expect(events).not.toContain("block.resume.skip.content-corrupt");
  });

  it("flips back via the CONTENT-CORRUPT guard when content_json is unrecoverable (parser ok:false)", async () => {
    // The genuinely-corrupt input reachable in prod: the jsonb null literal.
    // content_json is `jsonb NOT NULL` and rowFromDb re-stringifies every value,
    // so a malformed string can't reach the parser — but `'null'::jsonb` does:
    // JSON.stringify(null) -> "null" -> property access throws -> parser ok:false.
    // This pins the resume side of the dispatch-vs-resume divergence: resume
    // HONORS ok (bails terminal-corrupt), where dispatch ignores it (forks empty).
    await insertUserBlockWithContent("blk-resume-corrupt", { text: "placeholder" });
    await getDb()
      .update(schema.blocks)
      .set({ contentJson: sql`'null'::jsonb` })
      .where(eq(schema.blocks.blockId, "blk-resume-corrupt"));
    await insertErrorBlock("blk-resume-corrupt");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");

    vi.mocked(registry.getAgent).mockResolvedValue(stubAgent("test-agent"));
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);
    vi.mocked(lifecycle.peekLiveWorker).mockReturnValue({
      status: "idle",
    } as ReturnType<typeof lifecycle.peekLiveWorker>);
    const logSpy = vi.spyOn(logger, "log");

    await _processResumeRequestedRow("blk-resume-corrupt");

    expect(lifecycle.dispatchTurn).not.toHaveBeenCalled();
    expect(await getStatus("blk-resume-corrupt")).toBe("complete");
    const events = logSpy.mock.calls.map((c) => c[1]);
    expect(events).toContain("block.resume.skip.content-corrupt");
    expect(events).not.toContain("block.resume.skip.empty-text");
  });

  it("dispatches a Resume of a user_chat block to a SCHEDULED-type agent long-lived (FRI-156 SEV-0)", async () => {
    // Resume re-fires an INTERACTIVE user turn the user is waiting on. A
    // scheduled-type agent must NOT run one-shot here — that short-circuits the
    // worker loop and the resumed message silently vanishes (same chain as the
    // sendUserMessage path). Gate on the block source, not the agent type.
    await insertUserBlock("blk-resume-sched", "resume_requested");
    await insertErrorBlock("blk-resume-sched");
    const registry = await import("./registry.js");
    const lifecycle = await import("./lifecycle.js");
    const skills = await import("../skills/match.js");
    const { _processResumeRequestedRow } = await import("./resume-listener.js");
    vi.mocked(skills.matchSkillInvocation).mockReturnValue(null);

    vi.mocked(registry.getAgent).mockResolvedValue({
      name: "test-agent",
      type: "scheduled",
      status: "idle",
      taskPrompt: "do the thing",
      paused: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as ReturnType<typeof registry.getAgent> extends Promise<infer T> ? T : never);
    vi.mocked(lifecycle.findAgentByTurnId).mockReturnValue(null);
    vi.mocked(lifecycle.peekLiveWorker).mockReturnValue({
      status: "idle",
    } as ReturnType<typeof lifecycle.peekLiveWorker>);

    await _processResumeRequestedRow("blk-resume-sched");

    expect(lifecycle.dispatchTurn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(lifecycle.dispatchTurn).mock.calls[0]?.[0] as {
      options: { mode: string; turnSource?: string };
    };
    expect(call.options.mode).toBe("long-lived");
    expect(call.options.turnSource).toBe("user_chat");
  });
});
