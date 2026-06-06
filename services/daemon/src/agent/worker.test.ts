/**
 * FRI-156 §A/§C + FRI-27: worker-side compaction wiring.
 *
 * Covers the pure, testable seams introduced for compaction:
 *   - buildQueryOptions sets settings.autoCompactWindow per agent type (§A).
 *   - classifyStatusFrame maps the SDK system/status frame to a
 *     `compacting-status` WorkerEvent (or null) for the three live shapes (§C).
 *   - buildFlushQueryOptions pins the FRI-27 flush invariants: resume +
 *     forkSession BOTH set (OVERRIDES.md #1), allowedTools EXACTLY the three
 *     memory tools, disallowedTools includes 'Task', large autoCompactWindow.
 *   - runMemoryFlush emits start + complete(savedCount) and counts ONLY
 *     memory_save tool_use frames.
 *   - The PreCompact hook is registered on the turn query() for non-builder
 *     agents and ABSENT for builders.
 *
 * Strategy mirrors worker-compaction.test.ts: mock the SDK `query`, the MCP
 * builder, the daemon HTTP boundary, and the hook registry, then isolate-import
 * the worker for the run-driven assertions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Nearly every test here does `vi.resetModules()` + a fresh dynamic
// `import("./worker.js")`, and the FIRST import in the file pays a cold
// transform of the whole worker module graph. On a loaded CI runner that
// alone has been observed at >5s (the vitest default per-test timeout),
// flaking whichever test happens to run first. Raise the file's budget —
// this is import latency, not a behavior under test.
vi.setConfig({ testTimeout: 20_000 });

// Prevent the worker's one-shot `process.exit(0)` from killing vitest.
vi.spyOn(process, "exit").mockImplementation((_code?: number | string) => {
  return undefined as never;
});

const mockQueryImpl = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQueryImpl(...args),
}));
vi.mock("../mcp/builder.js", () => ({ buildMcpServers: vi.fn(() => ({})) }));
vi.mock("../comms/mail-prompt.js", () => ({ buildMailPrompt: vi.fn(() => "") }));

const mockDaemonFetch = vi.fn();
vi.mock("../mcp/http.js", () => ({
  daemonFetch: (...args: unknown[]) => mockDaemonFetch(...args),
}));
vi.mock("@friday/shared/services", () => ({
  readAttachmentBytes: vi.fn().mockResolvedValue(null),
}));
vi.mock("../hooks/register.js", () => ({}));
// Spy-able logger so the §A autoCompactWindow runtime probe
// (`worker.compact.window.probe`) and the FRI-27 PostCompact log
// (`worker.compact.post`) can be asserted on by event name + payload shape.
const loggerLogMock = vi.hoisted(() => vi.fn());
vi.mock("../log.js", () => ({
  logger: { log: loggerLogMock, close: vi.fn() },
}));
vi.mock("@friday/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@friday/shared")>();
  return {
    ...actual,
    renderLocalDatetime: vi.fn(() => ""),
    runHooks: vi.fn().mockResolvedValue([]),
  };
});

// ---- shared helpers ----

async function* makeIterator(
  msgs: Record<string, unknown>[],
): AsyncGenerator<Record<string, unknown>> {
  for (const m of msgs) yield m;
}

const RESULT_MSG = {
  type: "result",
  stop_reason: "end_turn",
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  total_cost_usd: 0,
};

function makeStartCmd(agentType: string, cwd: string) {
  return {
    type: "start",
    options: {
      agentName: "test-agent",
      agentType,
      mode: "one-shot",
      workingDirectory: cwd,
      systemPrompt: "",
      prompt: "hello",
      turnId: "t_worker_test",
      model: "claude-opus-4-7",
      daemonPort: 9999,
    },
  };
}

/** Drive one one-shot worker run and return both the IPC sent to the parent
 *  AND the options the SDK `query` was called with on the MAIN turn.
 *
 *  vi.resetModules() leaves the PREVIOUS test's worker `process.on("message")`
 *  listener registered (the module can't unregister it), so a stale worker may
 *  also call the shared `mockQueryImpl`. We give each run a UNIQUE cwd and pick
 *  the query call whose options.cwd matches, ignoring stale-listener calls. */
async function runWorker(
  agentType: string,
  sdkMsgs: Record<string, unknown>[],
): Promise<{ sent: Record<string, unknown>[]; mainOptions: Record<string, unknown> }> {
  mockQueryImpl.mockImplementation(() => makeIterator(sdkMsgs));
  const cwd = `/tmp/test-worker-${agentType}-${Math.random().toString(36).slice(2)}`;

  const sent: Record<string, unknown>[] = [];
  const origSend = process.send;
  process.send = ((msg: Record<string, unknown>) => {
    sent.push(msg);
    return true;
  }) as typeof process.send;

  // NOTE: we do NOT remove `message` listeners — vitest's forks pool uses
  // process IPC, so stripping them hangs the runner. Instead each run uses a
  // UNIQUE cwd and we wait for (and read back) the query() call whose
  // options.cwd matches THIS run, ignoring any stale-listener worker's call.
  vi.resetModules();
  await import("./worker.js");
  process.emit("message", makeStartCmd(agentType, cwd) as never, undefined as never);

  const matchingCall = () =>
    mockQueryImpl.mock.calls
      .map((c) => c[0] as { options?: Record<string, unknown> })
      .find((c) => c?.options?.cwd === cwd);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (matchingCall()) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  process.send = origSend;
  return { sent, mainOptions: matchingCall()?.options ?? {} };
}

beforeEach(() => {
  vi.resetModules();
  mockQueryImpl.mockReset();
  mockDaemonFetch.mockReset();
  loggerLogMock.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

// ---- §A: buildQueryOptions autoCompactWindow per agent type ----

describe("buildQueryOptions: per-agent autoCompactWindow (FRI-156 §A)", () => {
  const AGENT_TYPES = ["orchestrator", "builder", "helper", "scheduled", "bare"] as const;

  for (const agentType of AGENT_TYPES) {
    it(`sets settings.autoCompactWindow = 200_000 for ${agentType}`, async () => {
      const { buildQueryOptions } = await import("./worker.js");
      const opts = {
        agentName: "a",
        agentType,
        workingDirectory: "/tmp/x",
        systemPrompt: "",
        prompt: "hi",
        turnId: "t1",
        model: "claude-opus-4-7",
        daemonPort: 9999,
      } as never;
      const result = buildQueryOptions(
        opts,
        { prompt: "hi" } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        {},
        undefined,
      );
      // Pin the exact number per the code default (DEFAULT_AUTO_COMPACT_WINDOW
      // is 200K for every type), and that autoMemoryEnabled stays false.
      expect(result).toMatchObject({
        settings: { autoMemoryEnabled: false, autoCompactWindow: 200_000 },
      });
    });
  }
});

// ---- §A: probeAutoCompactWindow runtime "takes-effect" probe ----

describe("probeAutoCompactWindow: confirms the SDK honors the window (FRI-156 §A)", () => {
  it("takes_effect:true when getContextUsage reports auto-compaction enabled and threshold <= window", async () => {
    const { probeAutoCompactWindow } = await import("./worker.js");
    const getContextUsage = vi.fn().mockResolvedValue({
      autoCompactThreshold: 180_000,
      isAutoCompactEnabled: true,
      maxTokens: 1_000_000,
    });
    const verdict = await probeAutoCompactWindow({ getContextUsage }, 200_000, "orch");
    expect(verdict).toEqual({ takesEffect: true, autoCompactThreshold: 180_000 });
    // The probe LOGGED the takes-effect verdict via getContextUsage — this is
    // the runtime confirmation the §A design para mandates.
    expect(getContextUsage).toHaveBeenCalledTimes(1);
    expect(loggerLogMock).toHaveBeenCalledWith(
      "info",
      "worker.compact.window.probe",
      expect.objectContaining({
        agent: "orch",
        configured_window: 200_000,
        auto_compact_threshold: 180_000,
        auto_compact_enabled: true,
        takes_effect: true,
      }),
    );
  });

  it("takes_effect:false + documented fallback when the SDK threshold exceeds the window", async () => {
    const { probeAutoCompactWindow } = await import("./worker.js");
    const getContextUsage = vi.fn().mockResolvedValue({
      autoCompactThreshold: 900_000,
      isAutoCompactEnabled: true,
      maxTokens: 1_000_000,
    });
    const verdict = await probeAutoCompactWindow({ getContextUsage }, 200_000, "orch");
    expect(verdict.takesEffect).toBe(false);
    expect(loggerLogMock).toHaveBeenCalledWith(
      "info",
      "worker.compact.window.probe",
      expect.objectContaining({
        takes_effect: false,
        fallback:
          "independent nightly sweep bounds context (SDK autoCompactThreshold did not reflect the window)",
      }),
    );
  });

  it("takes_effect:false + documented fallback when auto-compaction is disabled", async () => {
    const { probeAutoCompactWindow } = await import("./worker.js");
    const getContextUsage = vi.fn().mockResolvedValue({
      autoCompactThreshold: 180_000,
      isAutoCompactEnabled: false,
      maxTokens: 1_000_000,
    });
    const verdict = await probeAutoCompactWindow({ getContextUsage }, 200_000, "orch");
    expect(verdict.takesEffect).toBe(false);
    expect(loggerLogMock).toHaveBeenCalledWith(
      "info",
      "worker.compact.window.probe",
      expect.objectContaining({ takes_effect: false }),
    );
  });

  it("documents the SDK gap (fallback) when getContextUsage is absent on the Query", async () => {
    const { probeAutoCompactWindow } = await import("./worker.js");
    const verdict = await probeAutoCompactWindow({}, 200_000, "orch");
    expect(verdict).toEqual({ takesEffect: false });
    expect(loggerLogMock).toHaveBeenCalledWith(
      "info",
      "worker.compact.window.probe",
      expect.objectContaining({
        takes_effect: false,
        fallback: "independent nightly sweep bounds context (getContextUsage unavailable)",
      }),
    );
  });

  it("never throws into the turn when getContextUsage rejects — logs the fallback at warn", async () => {
    const { probeAutoCompactWindow } = await import("./worker.js");
    const getContextUsage = vi.fn().mockRejectedValue(new Error("control channel closed"));
    const verdict = await probeAutoCompactWindow({ getContextUsage }, 200_000, "orch");
    expect(verdict).toEqual({ takesEffect: false });
    expect(loggerLogMock).toHaveBeenCalledWith(
      "warn",
      "worker.compact.window.probe",
      expect.objectContaining({
        takes_effect: false,
        fallback: "independent nightly sweep bounds context (getContextUsage threw)",
        error: "control channel closed",
      }),
    );
  });
});

// ---- §C: classifyStatusFrame ----

describe("classifyStatusFrame: SDK system/status mapping (FRI-156 §C)", () => {
  it("status:'compacting' → phase:'start'", async () => {
    const { classifyStatusFrame } = await import("./worker.js");
    const ev = classifyStatusFrame(
      { type: "system", subtype: "status", status: "compacting" },
      "sess-1",
    );
    expect(ev).toEqual({ type: "compacting-status", sessionId: "sess-1", phase: "start" });
  });

  it("compact_result:'success' → phase:'done', result:'success' (no error)", async () => {
    const { classifyStatusFrame } = await import("./worker.js");
    const ev = classifyStatusFrame(
      { type: "system", subtype: "status", status: null, compact_result: "success" },
      "sess-2",
    );
    expect(ev).toEqual({
      type: "compacting-status",
      sessionId: "sess-2",
      phase: "done",
      result: "success",
    });
  });

  it("compact_result:'failed' + compact_error → phase:'done', result:'failed', error", async () => {
    const { classifyStatusFrame } = await import("./worker.js");
    const ev = classifyStatusFrame(
      {
        type: "system",
        subtype: "status",
        compact_result: "failed",
        compact_error: "ran out of room",
      },
      "sess-3",
    );
    expect(ev).toEqual({
      type: "compacting-status",
      sessionId: "sess-3",
      phase: "done",
      result: "failed",
      error: "ran out of room",
    });
  });

  it("status:'requesting' → null (unrelated to compaction)", async () => {
    const { classifyStatusFrame } = await import("./worker.js");
    const ev = classifyStatusFrame(
      { type: "system", subtype: "status", status: "requesting" },
      "sess-4",
    );
    expect(ev).toBeNull();
  });

  it("non-status system frame → null", async () => {
    const { classifyStatusFrame } = await import("./worker.js");
    expect(
      classifyStatusFrame({ type: "system", subtype: "compact_boundary" }, "sess-5"),
    ).toBeNull();
  });

  it("falls back to sessionId='' when sessionId is undefined", async () => {
    const { classifyStatusFrame } = await import("./worker.js");
    const ev = classifyStatusFrame(
      { type: "system", subtype: "status", status: "compacting" },
      undefined,
    );
    expect(ev).toMatchObject({ sessionId: "", phase: "start" });
  });
});

// ---- FRI-27: buildFlushQueryOptions ----

describe("buildFlushQueryOptions: flush invariants (FRI-27, OVERRIDES.md #1)", () => {
  const baseOpts = {
    agentName: "orch",
    agentType: "orchestrator",
    workingDirectory: "/tmp/orch",
    systemPrompt: "",
    prompt: "hi",
    turnId: "t1",
    model: "claude-opus-4-7",
    daemonPort: 9999,
  } as never;

  it("sets BOTH resume and forkSession (flush sees the conversation, forked off the user transcript)", async () => {
    const { buildFlushQueryOptions } = await import("./compact-flush.js");
    const o = buildFlushQueryOptions(baseOpts, "sess-flush-1", {});
    expect(o.resume).toBe("sess-flush-1");
    expect(o.forkSession).toBe(true);
  });

  it("restricts allowedTools to EXACTLY the three memory tools and disallows Task", async () => {
    const { buildFlushQueryOptions } = await import("./compact-flush.js");
    const o = buildFlushQueryOptions(baseOpts, "sess-flush-2", {});
    expect(o.allowedTools).toEqual([
      "mcp__friday-memory__memory_search",
      "mcp__friday-memory__memory_get",
      "mcp__friday-memory__memory_save",
    ]);
    expect(o.disallowedTools).toEqual(["Task"]);
  });

  it("STRUCTURALLY restricts availability: tools:[] (built-ins off) + memory-only mcpServers", async () => {
    const { buildFlushQueryOptions } = await import("./compact-flush.js");
    // The worker passes its FULL mcp set; the flush must reduce it to memory-only
    // so non-memory tools (mail/tickets/evolve/etc.) are not AVAILABLE under
    // bypassPermissions, not merely un-auto-approved.
    const fullSet = {
      "friday-memory": { __server: "memory" },
      "friday-mail": { __server: "mail" },
      "friday-evolve": { __server: "evolve" },
    } as never;
    const o = buildFlushQueryOptions(baseOpts, "sess-flush-tools", fullSet);
    // Built-in tools disabled.
    expect(o.tools).toEqual([]);
    // Only friday-memory survives in the MCP set.
    expect(Object.keys(o.mcpServers ?? {})).toEqual(["friday-memory"]);
    // bypassPermissions is paired with the explicit dangerous-skip flag.
    expect(o.permissionMode).toBe("bypassPermissions");
    expect(o.allowDangerouslySkipPermissions).toBe(true);
  });

  it("memory-only reduction drops everything when the memory server is absent", async () => {
    const { buildFlushQueryOptions } = await import("./compact-flush.js");
    const o = buildFlushQueryOptions(baseOpts, "sess-flush-nomem", {
      "friday-mail": {},
    } as never);
    expect(o.mcpServers).toEqual({});
  });

  it("wires options.abortController when an AbortController is supplied (and omits it otherwise)", async () => {
    const { buildFlushQueryOptions } = await import("./compact-flush.js");
    const ac = new AbortController();
    const withAc = buildFlushQueryOptions(baseOpts, "sess-flush-ac", {}, ac);
    expect(withAc.abortController).toBe(ac);
    const without = buildFlushQueryOptions(baseOpts, "sess-flush-ac2", {});
    expect(without.abortController).toBeUndefined();
  });

  it("uses a large autoCompactWindow so the flush itself never compacts", async () => {
    const { buildFlushQueryOptions } = await import("./compact-flush.js");
    const o = buildFlushQueryOptions(baseOpts, "sess-flush-3", {});
    expect(o.settings).toMatchObject({ autoMemoryEnabled: false, autoCompactWindow: 1_000_000 });
    expect(o.maxTurns).toBe(6);
  });

  it("COMPACT_FLUSH_SYSTEM_PROMPT is independent of any persona custom_instructions and mentions memory_save", async () => {
    const { COMPACT_FLUSH_SYSTEM_PROMPT } = await import("./compact-flush.js");
    expect(COMPACT_FLUSH_SYSTEM_PROMPT).toContain("about to be compacted");
    expect(COMPACT_FLUSH_SYSTEM_PROMPT).toContain("memory_save");
    expect(COMPACT_FLUSH_SYSTEM_PROMPT).toContain("false positives degrade recall");
    // Must NOT depend on FRI-156's persona-continuity wording.
    expect(COMPACT_FLUSH_SYSTEM_PROMPT).not.toContain("relationship tone");
  });
});

// ---- FRI-27: runMemoryFlush ----

describe("runMemoryFlush: emits start + complete(savedCount), counts memory_save frames", () => {
  const baseOpts = {
    agentName: "orch",
    agentType: "orchestrator",
    workingDirectory: "/tmp/orch",
    systemPrompt: "",
    prompt: "hi",
    turnId: "t1",
    model: "claude-opus-4-7",
    daemonPort: 9999,
  } as never;

  it("counts only memory_save tool_results that LANDED (non-error) and emits complete(savedCount)", async () => {
    const { runMemoryFlush } = await import("./compact-flush.js");
    mockDaemonFetch.mockResolvedValue([
      { title: "Brew dance", tags: ["ops", "ritual"] },
      { title: "Net negative", tags: [] },
    ]);
    // Three memory_save invocations + one memory_search (must NOT count).
    // Two saves LAND (non-error tool_result); one FAILS (is_error) so it must
    // be excluded — the AC is "rows LAND IN POSTGRES", not invocations.
    mockQueryImpl.mockImplementation(() =>
      makeIterator([
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "tu_search", name: "mcp__friday-memory__memory_search" },
              { type: "tool_use", id: "tu_save_ok1", name: "mcp__friday-memory__memory_save" },
              { type: "tool_use", id: "tu_save_ok2", name: "mcp__friday-memory__memory_save" },
              { type: "tool_use", id: "tu_save_fail", name: "mcp__friday-memory__memory_save" },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tu_search" },
              { type: "tool_result", tool_use_id: "tu_save_ok1" },
              { type: "tool_result", tool_use_id: "tu_save_ok2", is_error: false },
              { type: "tool_result", tool_use_id: "tu_save_fail", is_error: true },
            ],
          },
        },
        RESULT_MSG,
      ]),
    );

    const emitted: Record<string, unknown>[] = [];
    const signal = new AbortController().signal;
    await runMemoryFlush(
      baseOpts,
      "sess-flush-run",
      {},
      9999,
      (e) => emitted.push(e as Record<string, unknown>),
      signal,
    );

    expect(emitted[0]).toEqual({
      type: "memory-flush",
      phase: "start",
      sessionId: "sess-flush-run",
    });
    // Two landed saves; the failed save and the search are excluded.
    expect(emitted[1]).toEqual({
      type: "memory-flush",
      phase: "complete",
      sessionId: "sess-flush-run",
      savedCount: 2,
    });
    // The flush loaded the memory index from the daemon HTTP boundary.
    expect(mockDaemonFetch).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/memory", method: "GET", port: 9999 }),
    );
    // The sub-query ran with the flush options (resume + forkSession set).
    const flushOpts = mockQueryImpl.mock.calls[0]?.[0]?.options as Record<string, unknown>;
    expect(flushOpts.resume).toBe("sess-flush-run");
    expect(flushOpts.forkSession).toBe(true);
  });

  it("emits complete with savedCount:0 when no memory_save frames are seen", async () => {
    const { runMemoryFlush } = await import("./compact-flush.js");
    mockDaemonFetch.mockResolvedValue([]);
    mockQueryImpl.mockImplementation(() =>
      makeIterator([
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "nothing worth saving" }] },
        },
        RESULT_MSG,
      ]),
    );

    const emitted: Record<string, unknown>[] = [];
    await runMemoryFlush(
      baseOpts,
      "sess-empty",
      {},
      9999,
      (e) => emitted.push(e as Record<string, unknown>),
      new AbortController().signal,
    );

    expect(emitted.find((e) => e.phase === "complete")).toEqual({
      type: "memory-flush",
      phase: "complete",
      sessionId: "sess-empty",
      savedCount: 0,
    });
  });

  it("forwards an abort into the flush sub-query's abortController and stops the for-await loop", async () => {
    // The CRITICAL gap the old tests missed: they rejected the index FETCH, so
    // the inner query() was never reached. Here the fetch RESOLVES (common
    // case) and the signal is ALREADY aborted, so the flush query() IS reached.
    // Assert (a) the sub-query received an abortController wired to the signal
    // (already aborted), and (b) the for-await loop breaks immediately so a
    // torn-down flush keeps no count even though the iterator would yield saves.
    const { runMemoryFlush } = await import("./compact-flush.js");
    mockDaemonFetch.mockResolvedValue([{ title: "x", tags: [] }]);
    // The iterator WOULD count two saves if the loop didn't break on abort.
    mockQueryImpl.mockImplementation(() =>
      makeIterator([
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "s1", name: "mcp__friday-memory__memory_save" },
              { type: "tool_use", id: "s2", name: "mcp__friday-memory__memory_save" },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "s1" },
              { type: "tool_result", tool_use_id: "s2" },
            ],
          },
        },
        RESULT_MSG,
      ]),
    );

    const ac = new AbortController();
    ac.abort();
    const emitted: Record<string, unknown>[] = [];
    await runMemoryFlush(
      baseOpts,
      "sess-flush-aborted",
      {},
      9999,
      (e) => emitted.push(e as Record<string, unknown>),
      ac.signal,
    );

    // The sub-query received an abortController, and it is aborted (the SDK's
    // only abort lever — without this a stalled flush keeps running after
    // compaction proceeds).
    const flushOpts = mockQueryImpl.mock.calls.at(-1)?.[0]?.options as {
      abortController?: AbortController;
    };
    expect(flushOpts.abortController).toBeInstanceOf(AbortController);
    expect(flushOpts.abortController?.signal.aborted).toBe(true);
    // The loop broke on the aborted signal, so no saves were counted.
    expect(emitted.find((e) => e.phase === "complete")).toMatchObject({ savedCount: 0 });
  });
});

// ---- FRI-27: PreCompact hook registration + builder gate ----

describe("worker PreCompact hook registration (FRI-27)", () => {
  it("registers a PreCompact + PostCompact hook on the turn query() for a non-builder agent", async () => {
    const { mainOptions } = await runWorker("orchestrator", [RESULT_MSG]);
    const hooks = mainOptions.hooks as Record<string, unknown> | undefined;
    expect(hooks).toBeDefined();
    // PreToolUse always present; PreCompact + PostCompact added for non-builders.
    expect(hooks).toHaveProperty("PreToolUse");
    expect(hooks).toHaveProperty("PreCompact");
    expect(hooks).toHaveProperty("PostCompact");
    // The PreCompact matcher carries the 30-SECOND timeout.
    const preCompact = (hooks as { PreCompact: Array<{ timeout?: number; hooks: unknown[] }> })
      .PreCompact;
    expect(preCompact[0].timeout).toBe(30);
    expect(preCompact[0].hooks).toHaveLength(1);
  });

  it("does NOT register a PreCompact hook for a builder agent, but DOES register PostCompact", async () => {
    // OVERRIDES.md #2 / FRI-27 AC30: PostCompact is logging-only and runs for
    // ALL agent types (builders compact too). Only PreCompact is builder-gated
    // (builders have read-only memory, so a flush memory_save would error).
    const { mainOptions } = await runWorker("builder", [RESULT_MSG]);
    const hooks = mainOptions.hooks as Record<string, unknown> | undefined;
    expect(hooks).toBeDefined();
    expect(hooks).toHaveProperty("PreToolUse");
    expect(hooks).not.toHaveProperty("PreCompact");
    expect(hooks).toHaveProperty("PostCompact");
  });

  it("fires the §A autoCompactWindow runtime probe on the live turn query", async () => {
    // The runWorker mock returns a bare async iterator (no getContextUsage), so
    // the probe takes the documented-fallback branch — but the point of THIS
    // test is that the probe is WIRED onto the real turn query at all (a §A AC
    // gap was that the window was only SET, never probed at runtime).
    await runWorker("orchestrator", [RESULT_MSG]);
    const probeCall = loggerLogMock.mock.calls.find((c) => c[1] === "worker.compact.window.probe");
    expect(probeCall).toBeDefined();
    expect(probeCall?.[2]).toMatchObject({
      agent: "test-agent",
      configured_window: 200_000,
      takes_effect: false,
      fallback: "independent nightly sweep bounds context (getContextUsage unavailable)",
    });
  });
});

// ---- FRI-27: PostCompact log + PreCompact flush-failure isolation ----

/** Reach the single hook callback registered under `hooks[event][0].hooks[0]`
 *  from a completed worker run's MAIN-turn query options. */
function hookCallback(
  mainOptions: Record<string, unknown>,
  event: "PreCompact" | "PostCompact",
): (...a: unknown[]) => Promise<unknown> {
  const hooks = mainOptions.hooks as Record<
    string,
    Array<{ hooks: Array<(...a: unknown[]) => Promise<unknown>>; timeout?: number }>
  >;
  return hooks[event][0].hooks[0];
}

/** Re-install a capturing `process.send` so the worker module's `emit` closure
 *  (which reads `process.send` dynamically) routes IPC into `captured` while we
 *  drive a hook callback by hand. `runWorker` restores the original send before
 *  it returns, so the worker is otherwise quiescent. */
async function withCapturedSend<T>(
  fn: (captured: Record<string, unknown>[]) => Promise<T>,
): Promise<T> {
  const captured: Record<string, unknown>[] = [];
  const orig = process.send;
  process.send = ((msg: Record<string, unknown>) => {
    captured.push(msg);
    return true;
  }) as typeof process.send;
  try {
    return await fn(captured);
  } finally {
    process.send = orig;
  }
}

describe("worker PostCompact hook (FRI-27 — worker.compact.post)", () => {
  it("logs { trigger, summary_length } from compact_summary when the PostCompact callback fires", async () => {
    const { mainOptions } = await runWorker("orchestrator", [RESULT_MSG]);
    loggerLogMock.mockClear();
    const postCompact = hookCallback(mainOptions, "PostCompact");

    await postCompact(
      {
        session_id: "sess-post-1",
        trigger: "manual",
        compact_summary: "a twelve-char", // length 13
      },
      undefined,
      { signal: new AbortController().signal },
    );

    expect(loggerLogMock).toHaveBeenCalledWith("info", "worker.compact.post", {
      agent: "test-agent",
      session_id: "sess-post-1",
      trigger: "manual",
      summary_length: 13,
    });
  });

  it("logs summary_length:0 when compact_summary is absent (auto trigger)", async () => {
    const { mainOptions } = await runWorker("orchestrator", [RESULT_MSG]);
    loggerLogMock.mockClear();
    const postCompact = hookCallback(mainOptions, "PostCompact");

    await postCompact({ session_id: "sess-post-2", trigger: "auto" }, undefined, {
      signal: new AbortController().signal,
    });

    expect(loggerLogMock).toHaveBeenCalledWith("info", "worker.compact.post", {
      agent: "test-agent",
      session_id: "sess-post-2",
      trigger: "auto",
      summary_length: 0,
    });
  });
});

describe("worker PreCompact flush failure is isolated from the outer turn (FRI-27)", () => {
  it("a throwing/aborting flush never kills the turn — emits the error arm, returns {}, turn still completes", async () => {
    // The main turn ran to completion and emitted turn-complete BEFORE we drive
    // the (independently-firing) PreCompact callback with a failing flush.
    const { sent, mainOptions } = await runWorker("orchestrator", [RESULT_MSG]);
    const turnComplete = sent.find((m) => m.type === "turn-complete");
    expect(turnComplete).toBeDefined();

    // Simulate the SDK firing PreCompact mid-session with a flush that fails:
    // the memory-index fetch (the first awaited boundary in runMemoryFlush)
    // rejects, standing in for the 30s matcher-timeout SDK abort.
    mockDaemonFetch.mockRejectedValue(new Error("flush aborted (timeout)"));
    const preCompact = hookCallback(mainOptions, "PreCompact");

    const result = await withCapturedSend(async (captured) => {
      // MUST resolve, MUST NOT throw — isolation is the whole point.
      const r = await preCompact({ session_id: "sess-flush-fail" }, undefined, {
        signal: new AbortController().signal,
      });
      return { r, captured };
    });

    // The hook resolved to {} (compaction proceeds) rather than throwing out
    // into the SDK / turn.
    expect(result.r).toEqual({});
    // The failure surfaced as the memory-flush ERROR arm, not an uncaught throw.
    const errArm = result.captured.find((m) => m.type === "memory-flush" && m.phase === "error");
    expect(errArm).toMatchObject({
      type: "memory-flush",
      phase: "error",
      sessionId: "sess-flush-fail",
      message: "flush aborted (timeout)",
    });
    // The outer turn's turn-complete remains intact — the failing flush did not
    // retroactively corrupt or replace it.
    expect(sent.find((m) => m.type === "turn-complete")).toBe(turnComplete);
  });

  it("an already-aborted flush signal is forwarded and still does not kill the turn", async () => {
    const { sent, mainOptions } = await runWorker("orchestrator", [RESULT_MSG]);
    expect(sent.find((m) => m.type === "turn-complete")).toBeDefined();

    // The flush index fetch sees the aborted signal and the daemonFetch mock
    // rejects with an abort error; the hook must still resolve cleanly.
    const ac = new AbortController();
    ac.abort();
    mockDaemonFetch.mockRejectedValue(new Error("The operation was aborted"));
    const preCompact = hookCallback(mainOptions, "PreCompact");

    const { r, sawError } = await withCapturedSend(async (captured) => {
      const res = await preCompact({ session_id: "sess-flush-abort" }, undefined, {
        signal: ac.signal,
      });
      return {
        r: res,
        sawError: captured.some((m) => m.type === "memory-flush" && m.phase === "error"),
      };
    });

    expect(r).toEqual({});
    expect(sawError).toBe(true);
  });

  it("a SUCCESSFUL hook-driven flush emits EXACTLY [start, complete] (no duplicate start)", async () => {
    // Regression: the hook emitted phase:'start' AND runMemoryFlush emitted it
    // again → two worker.compact.flush.started lines per flush. Drive the REAL
    // PreCompact hook on a clean flush and assert the captured memory-flush
    // events are exactly [start, complete].
    const { mainOptions } = await runWorker("orchestrator", [RESULT_MSG]);
    mockDaemonFetch.mockResolvedValue([{ title: "x", tags: [] }]);
    mockQueryImpl.mockImplementation(() =>
      makeIterator([
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "s1", name: "mcp__friday-memory__memory_save" }],
          },
        },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "s1" }] } },
        RESULT_MSG,
      ]),
    );
    const preCompact = hookCallback(mainOptions, "PreCompact");

    const phases = await withCapturedSend(async (captured) => {
      await preCompact({ session_id: "sess-flush-ok" }, undefined, {
        signal: new AbortController().signal,
      });
      return captured.filter((m) => m.type === "memory-flush").map((m) => m.phase as string);
    });

    expect(phases).toEqual(["start", "complete"]);
  });

  it("a SECOND PreCompact for the same session while one is in flight is short-circuited (concurrency guard)", async () => {
    // FRI-27 §4: no two flushes per session in parallel. Hold the first flush
    // open (the index fetch never resolves) and fire a second PreCompact for the
    // SAME session — it must short-circuit (emit nothing, run no sub-query).
    const { mainOptions } = await runWorker("orchestrator", [RESULT_MSG]);
    let releaseFetch: (v: unknown) => void = () => {};
    mockDaemonFetch.mockImplementation(() => new Promise((resolve) => (releaseFetch = resolve)));
    const preCompact = hookCallback(mainOptions, "PreCompact");

    const phases = await withCapturedSend(async (captured) => {
      // First flush: starts and parks on the never-resolving fetch.
      const first = preCompact({ session_id: "sess-dup" }, undefined, {
        signal: new AbortController().signal,
      });
      // Let the first emit its 'start' and reach the await.
      await new Promise((r) => setTimeout(r, 10));
      const startsAfterFirst = captured.filter(
        (m) => m.type === "memory-flush" && m.phase === "start",
      ).length;
      // Second flush for the SAME session: must short-circuit, emitting nothing.
      const r2 = await preCompact({ session_id: "sess-dup" }, undefined, {
        signal: new AbortController().signal,
      });
      const startsAfterSecond = captured.filter(
        (m) => m.type === "memory-flush" && m.phase === "start",
      ).length;
      // Release the first so it can finish (resolve to an empty index).
      releaseFetch([]);
      await first;
      return { r2, startsAfterFirst, startsAfterSecond };
    });

    // Second call short-circuited to {} and added NO new start event.
    expect(phases.r2).toEqual({});
    expect(phases.startsAfterFirst).toBe(1);
    expect(phases.startsAfterSecond).toBe(1);
  });

  it("skips the flush entirely when no session id is resolvable (resume:'' would degrade silently)", async () => {
    const { mainOptions } = await runWorker("orchestrator", [RESULT_MSG]);
    const preCompact = hookCallback(mainOptions, "PreCompact");
    mockQueryImpl.mockClear();

    const { r, captured } = await withCapturedSend(async (cap) => {
      const res = await preCompact({}, undefined, { signal: new AbortController().signal });
      return { r: res, captured: cap };
    });

    expect(r).toEqual({});
    // No flush sub-query was issued (no resume:'' degraded run).
    expect(mockQueryImpl).not.toHaveBeenCalled();
    // A skip is signaled as the error arm with an empty sessionId.
    const skip = captured.find((m) => m.type === "memory-flush" && m.phase === "error");
    expect(skip).toMatchObject({
      sessionId: "",
      message: expect.stringContaining("no resolvable"),
    });
  });
});
