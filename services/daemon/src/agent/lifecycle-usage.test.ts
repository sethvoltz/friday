import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Cross-boundary contract: when the worker emits `turn-complete` with a
// usage payload, the lifecycle handler must insert a row into the `usage`
// table whose columns match the WorkerEvent shape. This pins the field-name
// mapping that the original bug regressed past.

const dataDir = mkdtempSync(join(tmpdir(), "friday-lifecycle-usage-"));
process.env.FRIDAY_DATA_DIR = dataDir;

beforeAll(async () => {
  const { runMigrations } = await import("@friday/shared");
  runMigrations();
});

afterAll(async () => {
  const { closeDb } = await import("@friday/shared");
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { getRawDb } = await import("@friday/shared");
  getRawDb().prepare("DELETE FROM usage").run();
});

function makeFakeWorker(): unknown {
  return {
    child: { send: () => {} },
    agentName: "test-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "turn-1",
    sessionId: "sess-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now() - 1000,
    spawnedAt: Date.now() - 5000,
    status: "working",
    nextPrompts: [],
    mode: "long-lived",
    lastExitStatus: "complete",
    completedAtLeastOnce: false,
  };
}

describe("lifecycle.handleEvent on turn-complete (cross-boundary)", () => {
  it("inserts a usage row whose columns map the SDK→protocol field names", async () => {
    const { handleEvent } = await import("./lifecycle.js");
    const { getRawDb } = await import("@friday/shared");

    handleEvent(makeFakeWorker() as never, {
      type: "turn-complete",
      sessionId: "sess-1",
      usage: {
        input_tokens: 1234,
        output_tokens: 567,
        cache_creation_tokens: 89,
        cache_read_tokens: 4321,
        cost_usd: 0.1234,
      },
    });

    const row = getRawDb()
      .prepare(
        "SELECT cost_usd, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, agent_name, model FROM usage",
      )
      .get() as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row).toMatchObject({
      cost_usd: 0.1234,
      input_tokens: 1234,
      output_tokens: 567,
      cache_creation_tokens: 89,
      cache_read_tokens: 4321,
      agent_name: "test-agent",
      model: "claude-opus-4-7",
    });
  });

  it("inserts nothing when turn-complete carries no usage payload", async () => {
    const { handleEvent } = await import("./lifecycle.js");
    const { getRawDb } = await import("@friday/shared");

    handleEvent(makeFakeWorker() as never, {
      type: "turn-complete",
      sessionId: "sess-1",
    });

    const { c } = getRawDb()
      .prepare("SELECT count(*) c FROM usage")
      .get() as { c: number };
    expect(c).toBe(0);
  });

  it("inserts nothing when there is no session id (neither worker nor event)", async () => {
    const { handleEvent } = await import("./lifecycle.js");
    const { getRawDb } = await import("@friday/shared");

    const w = makeFakeWorker() as Record<string, unknown>;
    w.sessionId = undefined;

    handleEvent(w as never, {
      type: "turn-complete",
      sessionId: "",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        cost_usd: 0.01,
      },
    });

    const { c } = getRawDb()
      .prepare("SELECT count(*) c FROM usage")
      .get() as { c: number };
    expect(c).toBe(0);
  });
});
