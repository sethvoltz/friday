/**
 * FRI-40 — integration tests for the evolve auto-triage hook in
 * `POST /api/evolve/scan`.
 *
 * Patterned after archive-endpoint.test.ts: createTestDb + startServer({ port: 0 })
 * + fetch. Key mechanics:
 *
 *  - FRIDAY_DATA_DIR is set to a fresh tmpdir at the TOP of the file, BEFORE
 *    any @friday/shared import, so CONFIG_PATH / DAEMON_LOG_PATH / the evolve
 *    proposals dir all bind to the scratch tree (per CLAUDE.md).
 *  - Config is captured once per startServer() (loadConfig). The flag-ON and
 *    flag-OFF suites therefore use SEPARATE server instances: write config.json
 *    to CONFIG_PATH, then startServer to capture that cfg.
 *  - dispatchTurn is mocked so no real Claude process spawns; all other
 *    lifecycle exports are preserved via the spread.
 *  - A deterministic promote-to-critical fixture is created via saveProposal
 *    (status "open", one high-severity high-frequency signal). scoreProposal
 *    yields 80 (severity floor 40 + freq boost 40 capped), so rerankAll
 *    promotes open→critical and the proposal lands in reranked.promoted —
 *    exercising the rerank promote surface end-to-end (AC #5b).
 *  - Daemon log lines are asserted by reading the daemon.jsonl under
 *    FRIDAY_DATA_DIR/logs (matches how logs are asserted elsewhere). Counts
 *    are taken as deltas around each scan so cross-suite writes don't bleed.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

const DATA_DIR = mkdtempSync(join(tmpdir(), "fri40-triage-"));
process.env.FRIDAY_DATA_DIR = DATA_DIR;
// Quiet the logger's stdout mirror so the test output stays clean; it still
// writes the JSONL file we assert against.
process.env.FRIDAY_LOG_STDOUT = "off";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/lifecycle.js", async (orig) => ({
  ...(await orig<typeof import("../agent/lifecycle.js")>()),
  dispatchTurn: vi.fn(),
}));

let handle: import("@friday/shared").TestDbHandle;
let registry: typeof import("../agent/registry.js");
let saveProposal: (typeof import("@friday/evolve"))["saveProposal"];
let updateProposal: (typeof import("@friday/evolve"))["updateProposal"];
let getLogPath: (typeof import("@friday/shared"))["getLogPath"];
let CONFIG_PATH: string;
let startServer: (typeof import("./server.js"))["startServer"];

let daemonLogPath: string;

function readLogLines(): string[] {
  if (!existsSync(daemonLogPath)) return [];
  return readFileSync(daemonLogPath, "utf8").split("\n").filter(Boolean);
}

/** Count lines whose `event` field equals `event` since `fromIndex`. */
function countEventSince(fromIndex: number, event: string): number {
  const lines = readLogLines().slice(fromIndex);
  let n = 0;
  for (const l of lines) {
    try {
      const o = JSON.parse(l) as { event?: string };
      if (o.event === event) n++;
    } catch {
      // ignore non-JSON lines
    }
  }
  return n;
}

async function startOnFreePort(): Promise<{ server: Server; port: number }> {
  const server = startServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port assigned");
  return { server, port: addr.port };
}

function scanUrl(port: number): string {
  return `http://127.0.0.1:${port}/api/evolve/scan`;
}

/**
 * Save a proposal that rerankAll() will promote open→critical: one
 * high-severity signal with count 10. scoreProposal => 40 (severity floor) +
 * min(40, log2(11)*12)=40 boost = 80 >= criticalScore 60, and severity=high
 * trips isCritical. The proposal is created `open`, so the FIRST rerankAll in
 * the scan flips it to critical and reports it in reranked.promoted.
 */
function fixtureProposal(title: string) {
  const now = new Date().toISOString();
  return saveProposal({
    title,
    type: "code",
    proposedChange: "x",
    createdBy: "test",
    status: "open",
    blastRadius: "low",
    signals: [
      {
        hash: `h_${title.replace(/\s+/g, "_")}`,
        source: "daemon",
        key: "worker.exit",
        severity: "high",
        count: 10,
        firstSeenAt: now,
        lastSeenAt: now,
        evidencePointers: [],
      },
    ],
  });
}

beforeAll(async () => {
  mkdirSync(join(DATA_DIR, "logs"), { recursive: true });
  // Some scan readers walk daemon.jsonl; ensure it exists so the scan never
  // 500s for an unrelated missing-file reason. scanDaemonLog returns [] when
  // the file is missing, but the logger also opens it 'a' on import — touch
  // it up front so countEventSince has a stable file from line 0.
  writeFileSync(join(DATA_DIR, "logs", "daemon.jsonl"), "");

  const shared = await import("@friday/shared");
  handle = await shared.createTestDb({ label: "fri40_triage" });
  getLogPath = shared.getLogPath;
  CONFIG_PATH = shared.CONFIG_PATH;
  daemonLogPath = getLogPath("daemon");

  const evolve = await import("@friday/evolve");
  saveProposal = evolve.saveProposal;
  updateProposal = evolve.updateProposal;

  registry = await import("../agent/registry.js");
  ({ startServer } = await import("./server.js"));
});

afterAll(async () => {
  await handle.drop();
});

describe("POST /api/evolve/scan auto-triage hook — flag OFF (AC #4)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    await handle.truncate();
    // Default config: no evolve key => flag falls through to undefined/off.
    writeFileSync(CONFIG_PATH, JSON.stringify({ orchestratorName: "friday" }) + "\n");
    ({ server, port } = await startOnFreePort());
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("does NOT spawn a triage helper and logs no evolve.triage.spawn line", async () => {
    const p = fixtureProposal("daemon worker exit loop OFF");
    const before = readLogLines().length;

    const res = await fetch(scanUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeFriction: false, includePreferences: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { promotedFromRerank: number };
    // The rerank promoted our fixture, proving the surface fired even with the
    // flag off (the hook is what's gated, not the promotion).
    expect(body.promotedFromRerank).toBeGreaterThanOrEqual(1);

    // No triage helper registered.
    expect(await registry.getAgent("triage-" + p.id)).toBeNull();
    const agents = await registry.listAgents();
    expect(agents.some((a) => a.name.startsWith("triage-"))).toBe(false);

    // No spawn log line of any triage flavor.
    expect(countEventSince(before, "evolve.triage.spawn")).toBe(0);
    expect(countEventSince(before, "evolve.triage.spawn.skip")).toBe(0);
    expect(countEventSince(before, "evolve.triage.spawn.error")).toBe(0);
  });
});

describe("POST /api/evolve/scan auto-triage hook — flag ON (AC #5 / #5b / #6)", () => {
  let server: Server;
  let port: number;
  let proposalId: string;

  beforeAll(async () => {
    await handle.truncate();
    // The hook spawns with parentName "scheduled-meta-daily"; its registry row
    // is what resolves callerType="scheduled" (which persists the reason and
    // passes the ADR-022 gate). The schedule seeds this agent in production.
    await registry.registerAgent({
      name: "scheduled-meta-daily",
      type: "scheduled",
      parentName: "friday",
    });
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ orchestratorName: "friday", evolve: { autoSpawnTriageHelpers: true } }) +
        "\n",
    );
    ({ server, port } = await startOnFreePort());
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("spawns exactly one read-only triage helper for the promoted proposal (AC #5 + #5b)", async () => {
    const p = fixtureProposal("daemon worker exit loop ON");
    proposalId = p.id;
    const before = readLogLines().length;

    const res = await fetch(scanUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeFriction: false, includePreferences: false }),
    });
    expect(res.status).toBe(200);

    const helper = await registry.getAgent("triage-" + p.id);
    expect(helper).not.toBeNull();
    expect(helper?.type).toBe("helper");

    // spawn_reason is persisted and contains the proposal id verbatim.
    const reason = await registry.getSpawnReason("triage-" + p.id);
    expect(reason).toContain(p.id);
    expect(reason).toContain("promoted to critical");

    // Exactly one spawn line for exactly one distinct promoted proposal.
    expect(countEventSince(before, "evolve.triage.spawn")).toBe(1);
    expect(countEventSince(before, "evolve.triage.spawn.error")).toBe(0);
  });

  it("re-promoting the proposal dedupes via 409 → one skip line, no second row (AC #6)", async () => {
    // The triage-<id> row from the previous test already exists. To re-present
    // the proposal to the hook we reset it to "open" so the scan's rerankAll
    // promotes it again (rerank only re-reports newly-critical proposals). The
    // hook then plans the same triage-<id> request, which hits the existing
    // registry row and gets a 409 — the dedup path.
    const all = await registry.listAgents();
    const triageRows = all.filter((a) => a.name.startsWith("triage-"));
    expect(triageRows.length).toBe(1);
    const existingName = triageRows[0].name;
    expect(existingName).toBe("triage-" + proposalId);

    updateProposal(proposalId, { status: "open" });

    const before = readLogLines().length;
    const res = await fetch(scanUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeFriction: false, includePreferences: false }),
    });
    expect(res.status).toBe(200);

    // Still exactly one triage row (no duplicate spawned).
    const after = (await registry.listAgents()).filter((a) => a.name.startsWith("triage-"));
    expect(after.length).toBe(1);
    expect(after[0].name).toBe(existingName);

    // The 409 dedup path logged exactly one skip, and no fresh spawn.
    expect(countEventSince(before, "evolve.triage.spawn.skip")).toBe(1);
    expect(countEventSince(before, "evolve.triage.spawn")).toBe(0);
  });
});

describe("POST /api/evolve/scan auto-triage hook — spawn failure tolerated (AC #7)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    await handle.truncate();
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ orchestratorName: "friday", evolve: { autoSpawnTriageHelpers: true } }) +
        "\n",
    );
    ({ server, port } = await startOnFreePort());
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  it("a registerAgent failure for the triage spawn is caught: 200, summary unchanged, error logged", async () => {
    // Register the caller parent so the gate resolves callerType="scheduled".
    await registry.registerAgent({
      name: "scheduled-meta-daily",
      type: "scheduled",
      parentName: "friday",
    });
    const p = fixtureProposal("daemon worker exit loop FAIL");

    // Force createAgent to throw on the triage spawn. registry is
    // `import * as registry` in server.ts, so spying the namespace export
    // intercepts the in-process call. getAgent still works (the dedup check
    // returns null since no triage row exists yet).
    const spy = vi.spyOn(registry, "registerAgent").mockRejectedValueOnce(new Error("boom"));

    const before = readLogLines().length;
    const res = await fetch(scanUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeFriction: false, includePreferences: false }),
    });

    // The scan itself must succeed despite the spawn failure.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { promotedToCritical: number; promotedFromRerank: number };
    // The fixture promotes via rerank, so promotedFromRerank reflects it; the
    // promotedToCritical (fresh-create surface) count is unchanged from the
    // no-hook run because the hook never mutates the summary.
    expect(body.promotedToCritical).toBe(0);
    expect(body.promotedFromRerank).toBeGreaterThanOrEqual(1);

    // The triage helper was NOT created (register threw)…
    expect(await registry.getAgent("triage-" + p.id)).toBeNull();
    // …and the failure was logged, not thrown. Exactly one triage request was
    // planned (single promoted proposal) and the spy rejects once, so exactly
    // one error line is emitted — pin the precise count, not a lower bound.
    expect(countEventSince(before, "evolve.triage.spawn.error")).toBe(1);

    spy.mockRestore();
  });
});

// FRI-40 extracted the POST /api/agents route body into the internal
// createAgent(input, cfg) so the in-process auto-triage hook can reuse it (and
// its 409 dedup). These contract tests pin that the HTTP route still returns
// identical status codes / bodies for every branch the extraction preserved.
// Folded into this file (rather than a standalone *.test.ts) so it reuses the
// single createTestDb above — a separate DB-backed file pushed the daemon
// suite past Postgres's connection ceiling under maxForks.
describe("POST /api/agents — contract (createAgent extraction)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    await handle.truncate();
    writeFileSync(CONFIG_PATH, JSON.stringify({ orchestratorName: "friday" }) + "\n");
    ({ server, port } = await startOnFreePort());
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function postAgent(payload: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  it("returns 400 for an invalid agent name", async () => {
    const res = await postAgent({ type: "helper", name: "Bad Name!", prompt: "x" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("invalid name");
    expect(await registry.getAgent("Bad Name!")).toBeNull();
  });

  it("returns 400 for a type this endpoint cannot create", async () => {
    const res = await postAgent({ type: "scheduled", name: "sched-via-rest", prompt: "x" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      'cannot create agent of type "scheduled"',
    );
    expect(await registry.getAgent("sched-via-rest")).toBeNull();
  });

  it("returns 409 when an agent with that name already exists", async () => {
    await registry.registerAgent({ name: "already-here", type: "helper" });
    const res = await postAgent({ type: "helper", name: "already-here", prompt: "x" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      'agent "already-here" already exists',
    );
  });

  it("returns 403 when a non-orchestrator caller tries to spawn a builder (ADR-022 gate)", async () => {
    await registry.registerAgent({ name: "parent-helper", type: "helper" });
    const res = await postAgent({
      type: "builder",
      name: "child-builder",
      parentName: "parent-helper",
      reason: "needs a worktree",
      prompt: "x",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("BUILDER_SPAWN_ORCHESTRATOR_ONLY");
    // The builder must not have been created (and no worktree cut).
    expect(await registry.getAgent("child-builder")).toBeNull();
  });

  it("returns 201 and persists the helper row on a valid orchestrator-spawned helper", async () => {
    const res = await postAgent({ type: "helper", name: "create-ok", prompt: "do the thing" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; turn_id: string };
    expect(body.name).toBe("create-ok");
    expect(body.turn_id).toMatch(/^t_/);
    expect((await registry.getAgent("create-ok"))?.type).toBe("helper");
    // Orchestrator-spawned helpers carry no spawnReason (per the gate).
    expect(await registry.getSpawnReason("create-ok")).toBeNull();
  });

  // FRI-16: the endpoint's own type allowlist must admit "planner" — the
  // pre-FRI-16 allowlist 400'd before validateSpawnPermissions ever ran, so
  // every planner cell of the spawn matrix died at this layer even though
  // the pure gate permitted it. These tests pin the endpoint, not the gate.
  it("returns 201 for an orchestrator-spawned planner and persists the planner row (FRI-16)", async () => {
    const res = await postAgent({
      type: "planner",
      name: "planner-via-rest",
      parentName: "friday",
      prompt: "design the migration",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; turn_id: string };
    expect(body.name).toBe("planner-via-rest");
    expect(body.turn_id).toMatch(/^t_/);
    // The row INSERT also proves the agents_type_check CHECK constraint
    // (widened by shared migration 0032) accepts 'planner' in a real DB.
    expect(await registry.getAgent("planner-via-rest")).toMatchObject({
      name: "planner-via-rest",
      type: "planner",
      parentName: "friday",
    });
    expect(await registry.getSpawnReason("planner-via-rest")).toBeNull();
  });

  it("returns 201 for a builder-spawned planner with reason; the spawn turn runs in the builder's worktree (FRI-16)", async () => {
    const worktree = join(DATA_DIR, "wt-parent-builder");
    await registry.registerAgent({
      name: "parent-builder",
      type: "builder",
      parentName: "friday",
      worktreePath: worktree,
    });
    const res = await postAgent({
      type: "planner",
      name: "planner-under-builder",
      parentName: "parent-builder",
      reason: "deep design on a stronger model",
      prompt: "plan the refactor",
    });
    expect(res.status).toBe(201);
    expect(await registry.getAgent("planner-under-builder")).toMatchObject({
      type: "planner",
      parentName: "parent-builder",
    });
    expect(await registry.getSpawnReason("planner-under-builder")).toBe(
      "deep design on a stronger model",
    );
    // The spawn-time dispatch must already run in the inherited cwd —
    // planner workers are long-lived, so the first session's cwd IS the
    // session cwd (and the middle-path guard keys off it).
    const lifecycle = await import("../agent/lifecycle.js");
    const call = vi
      .mocked(lifecycle.dispatchTurn)
      .mock.calls.find((c) => c[0].agentName === "planner-under-builder");
    expect(call?.[0].options.workingDirectory).toBe(worktree);
  });

  it("returns 400 (reason required) for a builder-spawned planner without reason", async () => {
    await registry.registerAgent({
      name: "parent-builder-2",
      type: "builder",
      parentName: "friday",
      worktreePath: join(DATA_DIR, "wt-parent-builder-2"),
    });
    const res = await postAgent({
      type: "planner",
      name: "planner-no-reason",
      parentName: "parent-builder-2",
      prompt: "plan it",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("SPAWN_REASON_REQUIRED");
    expect(await registry.getAgent("planner-no-reason")).toBeNull();
  });

  it("returns 403 PLANNER_SPAWN_FORBIDDEN when a planner caller tries to spawn (leaf rule, endpoint layer)", async () => {
    await registry.registerAgent({
      name: "parent-planner",
      type: "planner",
      parentName: "friday",
    });
    const res = await postAgent({
      type: "helper",
      name: "child-of-planner",
      parentName: "parent-planner",
      reason: "planners cannot delegate",
      prompt: "x",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("PLANNER_SPAWN_FORBIDDEN");
    expect(await registry.getAgent("child-of-planner")).toBeNull();
  });
});
