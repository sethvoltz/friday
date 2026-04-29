import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanFriction, type ScoredTurn, type TurnForScoring } from "./scan-friction.js";

let workDir: string;
let projectsRoot: string;
let agentsPath: string;

const ORCH_SESSION = "session-orch-1";
const FORMER_SESSION = "session-orch-0";
const BUILDER_SESSION = "session-builder-1";

function writeRegistry(registry: Record<string, unknown>): void {
  writeFileSync(agentsPath, JSON.stringify(registry, null, 2));
}

function writeSessionFile(sessionId: string, lines: object[]): string {
  const dir = join(projectsRoot, "-Users-seth-Development-Friday");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(filePath, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
  return filePath;
}

function userTurn(uuid: string, text: string, timestamp = "2026-04-27T12:00:00.000Z"): object {
  return {
    type: "user",
    uuid,
    timestamp,
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantTurn(text: string, timestamp = "2026-04-27T11:59:50.000Z"): object {
  return {
    type: "assistant",
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

describe("scanFriction", () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "friday-evolve-friction-"));
    projectsRoot = join(workDir, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    agentsPath = join(workDir, "agents.json");
    writeRegistry({
      orchestrator: {
        type: "orchestrator",
        sessionId: ORCH_SESSION,
        formerSessionIds: [FORMER_SESSION],
      },
      "builder-test": {
        type: "builder",
        sessionId: BUILDER_SESSION,
      },
    });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("returns empty when projects root is missing", async () => {
    const result = await scanFriction({
      projectsRoot: join(workDir, "missing"),
      agentsPath,
    });
    expect(result).toEqual([]);
  });

  it("returns empty when no orchestrator sessions are registered", async () => {
    writeRegistry({});
    writeSessionFile(ORCH_SESSION, [userTurn("u1", "hello")]);
    const result = await scanFriction({ projectsRoot, agentsPath });
    expect(result).toEqual([]);
  });

  it("buckets turns into category-keyed signals with correct counts", async () => {
    writeSessionFile(ORCH_SESSION, [
      assistantTurn("Sure, I'll deploy to staging."),
      userTurn("u1", "no, I said production not staging", "2026-04-27T12:00:00.000Z"),
      assistantTurn("OK, deploying to production now."),
      userTurn("u2", "wait, why are you using docker?", "2026-04-27T12:05:00.000Z"),
      assistantTurn("Docker is the configured runner."),
      userTurn("u3", "you keep ignoring the env file", "2026-04-27T12:10:00.000Z"),
    ]);

    const scoreFn = async (batch: TurnForScoring[]): Promise<ScoredTurn[]> => {
      return batch.map((t) => {
        if (t.turn_id === "u1") {
          return { turn_id: "u1", friction_score: 3, category: "correction", reason: "explicit fix" };
        }
        if (t.turn_id === "u2") {
          return { turn_id: "u2", friction_score: 2, category: "confusion", reason: "why question" };
        }
        return { turn_id: "u3", friction_score: 4, category: "frustration", reason: "you keep" };
      });
    };

    const signals = await scanFriction({ projectsRoot, agentsPath, scoreFn });
    expect(signals).toHaveLength(3);
    const byKey = Object.fromEntries(signals.map((s) => [s.key, s]));
    expect(byKey.friction_correction.count).toBe(1);
    expect(byKey.friction_correction.severity).toBe("medium");
    expect(byKey.friction_confusion.count).toBe(1);
    expect(byKey.friction_confusion.severity).toBe("low");
    expect(byKey.friction_frustration.count).toBe(1);
    expect(byKey.friction_frustration.severity).toBe("high");
    for (const s of signals) {
      expect(s.agent).toBe("orchestrator");
      expect(s.evidencePointers[0].sessionId).toBe(ORCH_SESSION);
    }
  });

  it("ignores low-friction and 'none' turns", async () => {
    writeSessionFile(ORCH_SESSION, [
      userTurn("u1", "no problem, take your time"),
      userTurn("u2", "sounds good"),
    ]);

    const scoreFn = async (): Promise<ScoredTurn[]> => [
      { turn_id: "u1", friction_score: 0, category: "none", reason: "polite" },
      { turn_id: "u2", friction_score: 1, category: "none", reason: "agreement" },
    ];

    const signals = await scanFriction({ projectsRoot, agentsPath, scoreFn });
    expect(signals).toEqual([]);
  });

  it("only scans orchestrator sessions, not other agents", async () => {
    writeSessionFile(BUILDER_SESSION, [userTurn("u1", "no, that's wrong")]);

    const scoreFn = async (batch: TurnForScoring[]): Promise<ScoredTurn[]> =>
      batch.map((t) => ({
        turn_id: t.turn_id,
        friction_score: 4,
        category: "correction" as const,
        reason: "wrong",
      }));

    const signals = await scanFriction({ projectsRoot, agentsPath, scoreFn });
    expect(signals).toEqual([]);
  });

  it("includes turns from former orchestrator sessions", async () => {
    writeSessionFile(FORMER_SESSION, [userTurn("u-former", "no, the path is /a not /b")]);

    const scoreFn = async (batch: TurnForScoring[]): Promise<ScoredTurn[]> =>
      batch.map((t) => ({
        turn_id: t.turn_id,
        friction_score: 3,
        category: "correction" as const,
        reason: "path correction",
      }));

    const signals = await scanFriction({ projectsRoot, agentsPath, scoreFn });
    expect(signals).toHaveLength(1);
    expect(signals[0].evidencePointers[0].sessionId).toBe(FORMER_SESSION);
  });

  it("strips memory-context blocks before scoring", async () => {
    writeSessionFile(ORCH_SESSION, [
      userTurn(
        "u1",
        "<memory-context>some recall here</memory-context>\n\nno, that's not right"
      ),
    ]);

    let captured: TurnForScoring[] = [];
    const scoreFn = async (batch: TurnForScoring[]): Promise<ScoredTurn[]> => {
      captured = batch;
      return batch.map((t) => ({
        turn_id: t.turn_id,
        friction_score: 2,
        category: "correction" as const,
        reason: "fix",
      }));
    };

    await scanFriction({ projectsRoot, agentsPath, scoreFn });
    expect(captured[0].user_text).not.toContain("<memory-context>");
    expect(captured[0].user_text).toContain("not right");
  });

  it("skips tool_result-only turns", async () => {
    writeSessionFile(ORCH_SESSION, [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-04-27T12:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      },
    ]);

    const scoreFn = async (batch: TurnForScoring[]): Promise<ScoredTurn[]> =>
      batch.map((t) => ({
        turn_id: t.turn_id,
        friction_score: 5,
        category: "frustration" as const,
        reason: "n/a",
      }));

    const signals = await scanFriction({ projectsRoot, agentsPath, scoreFn });
    expect(signals).toEqual([]);
  });

  it("respects the since filter on file mtime", async () => {
    writeSessionFile(ORCH_SESSION, [userTurn("u1", "no, wrong file", "2026-01-01T00:00:00.000Z")]);

    const scoreFn = async (batch: TurnForScoring[]): Promise<ScoredTurn[]> =>
      batch.map((t) => ({
        turn_id: t.turn_id,
        friction_score: 3,
        category: "correction" as const,
        reason: "fix",
      }));

    const signals = await scanFriction({
      projectsRoot,
      agentsPath,
      scoreFn,
      since: "2030-01-01T00:00:00.000Z",
    });
    // since is in the future; mtime will be older → file skipped
    expect(signals).toEqual([]);
  });

  it("merges multiple turns of the same category into one signal with severity promotion", async () => {
    writeSessionFile(ORCH_SESSION, [
      userTurn("u1", "no, deploy to prod", "2026-04-27T12:00:00.000Z"),
      userTurn("u2", "no, prod, like I said", "2026-04-27T12:05:00.000Z"),
      userTurn("u3", "STOP. PRODUCTION.", "2026-04-27T12:10:00.000Z"),
    ]);

    const scores: Record<string, ScoredTurn> = {
      u1: { turn_id: "u1", friction_score: 2, category: "correction", reason: "fix" },
      u2: { turn_id: "u2", friction_score: 3, category: "correction", reason: "repeat fix" },
      u3: { turn_id: "u3", friction_score: 5, category: "correction", reason: "yelling" },
    };
    const scoreFn = async (batch: TurnForScoring[]): Promise<ScoredTurn[]> =>
      batch.map((t) => scores[t.turn_id]);

    const signals = await scanFriction({ projectsRoot, agentsPath, scoreFn });
    expect(signals).toHaveLength(1);
    expect(signals[0].count).toBe(3);
    expect(signals[0].severity).toBe("high");
    // Up to 3 evidence pointers, ranked highest-friction first.
    expect(signals[0].evidencePointers).toHaveLength(3);
  });

  it("does not call scoreFn when there are no scoreable turns", async () => {
    writeSessionFile(ORCH_SESSION, [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-04-27T12:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      },
    ]);

    let called = 0;
    const scoreFn = async (batch: TurnForScoring[]): Promise<ScoredTurn[]> => {
      called++;
      return batch.map((t) => ({
        turn_id: t.turn_id,
        friction_score: 0,
        category: "none" as const,
        reason: "",
      }));
    };

    await scanFriction({ projectsRoot, agentsPath, scoreFn });
    expect(called).toBe(0);
  });
});
