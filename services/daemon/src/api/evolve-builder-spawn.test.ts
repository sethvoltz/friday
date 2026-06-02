/**
 * FRI-149 — integration tests for the evolve auto-builder-escalation hook in
 * `POST /api/evolve/scan`, plus the forge-resistance of the carve-out.
 *
 * Patterned after evolve-triage-spawn.test.ts: createTestDb + startServer({ port: 0 })
 * + fetch. Key mechanics SPECIFIC to builders:
 *
 *  - FRIDAY_DATA_DIR is set to a fresh tmpdir at the TOP, BEFORE any
 *    @friday/shared import, so CONFIG_PATH / DAEMON_LOG_PATH / the evolve
 *    proposals dir bind to the scratch tree (per CLAUDE.md).
 *  - dispatchTurn is mocked (no real Claude process) AND createWorkspace is
 *    mocked. Builders (unlike triage helpers) call createWorkspace, which would
 *    cut a REAL git worktree + branch on disk; the stub returns a fake
 *    Workspace so no git ops run.
 *  - A deterministic promote-to-critical fixture (status "open", one
 *    high-severity high-frequency signal, type "code") is created via
 *    saveProposal. scoreProposal yields 80, so the scan's rerankAll promotes
 *    open→critical and the proposal lands in reranked.promoted — exercising the
 *    rerank promote surface end-to-end.
 *  - Daemon log lines are asserted by reading daemon.jsonl under
 *    FRIDAY_DATA_DIR/logs with delta-from-index counts.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

const DATA_DIR = mkdtempSync(join(tmpdir(), "fri149-builder-"));
process.env.FRIDAY_DATA_DIR = DATA_DIR;
process.env.FRIDAY_LOG_STDOUT = "off";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../agent/lifecycle.js", async (orig) => ({
  ...(await orig<typeof import("../agent/lifecycle.js")>()),
  dispatchTurn: vi.fn(),
}));

// Builders call createWorkspace, which cuts a real git worktree + branch. Stub
// it so the spawn path runs end-to-end (registerAgent, telemetry, dispatch)
// without touching git. Returns the shape createWorkspace produces.
vi.mock("../agent/workspace.js", async (orig) => ({
  ...(await orig<typeof import("../agent/workspace.js")>()),
  createWorkspace: vi.fn((opts: { name: string; baseRepo: string; branch: string }) => ({
    path: join(DATA_DIR, "workspaces", opts.name),
    branch: opts.branch,
    baseRepo: opts.baseRepo,
  })),
}));

let handle: import("@friday/shared").TestDbHandle;
let registry: typeof import("../agent/registry.js");
let saveProposal: (typeof import("@friday/evolve"))["saveProposal"];
let getProposal: (typeof import("@friday/evolve"))["getProposal"];
let getLogPath: (typeof import("@friday/shared"))["getLogPath"];
let CONFIG_PATH: string;
let startServer: (typeof import("./server.js"))["startServer"];

let daemonLogPath: string;

function readLogLines(): string[] {
  if (!existsSync(daemonLogPath)) return [];
  return readFileSync(daemonLogPath, "utf8").split("\n").filter(Boolean);
}

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
 * Save a proposal that rerankAll() will promote open→critical AND that
 * qualifies for builder escalation: type "code", one high-severity signal with
 * count 10. scoreProposal => 40 (severity floor) + min(40, log2(11)*12)=40 = 80
 * >= criticalScore 60; severity=high trips isCritical AND the high-filter.
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
  writeFileSync(join(DATA_DIR, "logs", "daemon.jsonl"), "");

  const shared = await import("@friday/shared");
  handle = await shared.createTestDb({ label: "fri149_builder" });
  getLogPath = shared.getLogPath;
  CONFIG_PATH = shared.CONFIG_PATH;
  daemonLogPath = getLogPath("daemon");

  const evolve = await import("@friday/evolve");
  saveProposal = evolve.saveProposal;
  getProposal = evolve.getProposal;

  registry = await import("../agent/registry.js");
  ({ startServer } = await import("./server.js"));
});

afterAll(async () => {
  await handle.drop();
  vi.restoreAllMocks();
});

describe("POST /api/evolve/scan auto-builder hook — flag OFF (AC #6)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    await handle.truncate();
    // autoSpawnTriageHelpers true to prove the BUILDER hook is separately gated:
    // a triage helper may spawn, but no builder, with autoSpawnBuilders off.
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

  it("does NOT spawn a builder and logs no evolve.builder.spawn line", async () => {
    const p = fixtureProposal("daemon worker exit code OFF");
    const before = readLogLines().length;

    const res = await fetch(scanUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeFriction: false, includePreferences: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { promotedFromRerank: number };
    expect(body.promotedFromRerank).toBeGreaterThanOrEqual(1);

    expect(await registry.getAgent("builder-" + p.id)).toBeNull();
    expect(countEventSince(before, "evolve.builder.spawn")).toBe(0);
    // The proposal carries no builder linkage.
    expect(getProposal(p.id)?.builderAgent).toBe(null);
  });
});

describe("POST /api/evolve/scan auto-builder hook — flag ON (AC #7 / #8)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    await handle.truncate();
    await registry.registerAgent({
      name: "scheduled-meta-daily",
      type: "scheduled",
      parentName: "friday",
    });
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ orchestratorName: "friday", evolve: { autoSpawnBuilders: true } }) + "\n",
    );
    ({ server, port } = await startOnFreePort());
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("spawns exactly one builder, linked + audited, for the promoted proposal (AC #7 + #8)", async () => {
    const p = fixtureProposal("daemon worker exit code ON");
    const before = readLogLines().length;

    const res = await fetch(scanUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeFriction: false, includePreferences: false }),
    });
    expect(res.status).toBe(200);

    // Exactly one builder row, of type builder.
    const builder = await registry.getAgent("builder-" + p.id);
    expect(builder).not.toBeNull();
    expect(builder?.type).toBe("builder");

    // spawn_reason persisted and contains the proposal id verbatim.
    const reason = await registry.getSpawnReason("builder-" + p.id);
    expect(reason).toContain(p.id);

    // Exactly one spawn line, no error line.
    expect(countEventSince(before, "evolve.builder.spawn")).toBe(1);
    expect(countEventSince(before, "evolve.builder.spawn.error")).toBe(0);

    // Two-way linkage persisted on the proposal (AC #8).
    expect(getProposal(p.id)?.builderAgent).toBe("builder-" + p.id);
  });

  it("re-promoting dedupes via 409 → one skip line, no second row", async () => {
    const all = await registry.listAgents();
    const builderRows = all.filter((a) => a.name.startsWith("builder-"));
    expect(builderRows.length).toBe(1);
    const existingName = builderRows[0].name;

    // Reset to open so the next scan's rerank re-promotes it.
    const evolve = await import("@friday/evolve");
    evolve.updateProposal(existingName.slice("builder-".length), { status: "open" });

    const before = readLogLines().length;
    const res = await fetch(scanUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeFriction: false, includePreferences: false }),
    });
    expect(res.status).toBe(200);

    const after = (await registry.listAgents()).filter((a) => a.name.startsWith("builder-"));
    expect(after.length).toBe(1);
    expect(after[0].name).toBe(existingName);

    expect(countEventSince(before, "evolve.builder.spawn.skip")).toBe(1);
    expect(countEventSince(before, "evolve.builder.spawn")).toBe(0);
  });
});

describe("POST /api/evolve/scan auto-builder hook — spawn failure tolerated (AC #11)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    await handle.truncate();
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ orchestratorName: "friday", evolve: { autoSpawnBuilders: true } }) + "\n",
    );
    ({ server, port } = await startOnFreePort());
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("a registerAgent failure for the builder spawn is caught: 200, summary unchanged, error logged", async () => {
    await registry.registerAgent({
      name: "scheduled-meta-daily",
      type: "scheduled",
      parentName: "friday",
    });
    const p = fixtureProposal("daemon worker exit code FAIL");

    const spy = vi.spyOn(registry, "registerAgent").mockRejectedValueOnce(new Error("boom"));

    const before = readLogLines().length;
    const res = await fetch(scanUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeFriction: false, includePreferences: false }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { promotedToCritical: number; promotedFromRerank: number };
    expect(body.promotedToCritical).toBe(0);
    expect(body.promotedFromRerank).toBeGreaterThanOrEqual(1);

    // Builder NOT created (register threw)…
    expect(await registry.getAgent("builder-" + p.id)).toBeNull();
    // …and the failure was logged, not thrown. Exactly one error line.
    expect(countEventSince(before, "evolve.builder.spawn.error")).toBe(1);
    // No linkage written when the spawn failed.
    expect(getProposal(p.id)?.builderAgent).toBe(null);

    spy.mockRestore();
  });
});

// AC #9 (forge-resistance, REQUIRED). The public POST /api/agents route passes
// NO evolveEscalation arg to createAgent, so a wire client cannot reach the
// carve-out — even by naming the daemon-seeded "scheduled-meta-daily" parent
// (which DOES resolve callerType="scheduled"). The unconditional builder→403
// must still fire.
describe("POST /api/agents — wire client cannot forge the evolve carve-out (AC #9)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    await handle.truncate();
    // Register the scheduled parent so callerType resolves to "scheduled" — the
    // exact precondition the carve-out narrows on. The route STILL must 403,
    // because it never passes evolveEscalation.
    await registry.registerAgent({
      name: "scheduled-meta-daily",
      type: "scheduled",
      parentName: "friday",
    });
    writeFileSync(CONFIG_PATH, JSON.stringify({ orchestratorName: "friday" }) + "\n");
    ({ server, port } = await startOnFreePort());
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("builder spawn naming the scheduled parent (even with evolveEscalation in the body) → 403, no row", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "builder",
        name: "rogue-builder",
        parentName: "scheduled-meta-daily",
        reason: "evolve escalation: proposal p-aaaa",
        prompt: "x",
        // A client trying to forge the marker via the body — must be ignored,
        // because createAgent reads its own opts param, not the body.
        evolveEscalation: true,
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("BUILDER_SPAWN_ORCHESTRATOR_ONLY");
    expect(await registry.getAgent("rogue-builder")).toBeNull();
  });
});
