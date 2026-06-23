/**
 * FRI-142 / ADR-048 producer seam #5 — evolve_critical.
 *
 * `POST /api/evolve/scan` fires `notify({ type: "evolve_critical", priority:
 * "critical" })` exactly once when a proposal is promoted to critical on EITHER
 * promote surface (fresh-create `propose.promotedToCritical` OR rerank
 * `reranked.promoted`). A scan with NO critical promotion fires nothing. The
 * call is fire-and-forget and never alters the scan's 200 response.
 *
 * Patterned after evolve-triage-spawn.test.ts: FRIDAY_DATA_DIR set BEFORE any
 * @friday/shared import, createTestDb + startServer({ port: 0 }) + fetch, and a
 * deterministic promote-to-critical fixture via saveProposal (status "open",
 * one high-severity high-frequency signal ⇒ rerankAll flips it open→critical).
 * The router itself is mocked so we observe exactly which event the seam fired
 * — the seam is the unit under test, not the router (covered by notify.test.ts).
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

const DATA_DIR = mkdtempSync(join(tmpdir(), "fri142-evolve-notify-"));
process.env.FRIDAY_DATA_DIR = DATA_DIR;
process.env.FRIDAY_LOG_STDOUT = "off";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// dispatchTurn is mocked so the FRI-40/FRI-149 spawn blocks (off by default in
// this config) never spawn a real Claude process even if they were enabled.
vi.mock("../agent/lifecycle.js", async (orig) => ({
  ...(await orig<typeof import("../agent/lifecycle.js")>()),
  dispatchTurn: vi.fn(),
}));

// The router under observation: a spy recording every notify() the seam fires.
const notifySpy = vi.fn();
vi.mock("../notifications/notify.js", () => ({ notify: (e: unknown) => notifySpy(e) }));

let handle: import("@friday/shared").TestDbHandle;
let saveProposal: (typeof import("@friday/evolve"))["saveProposal"];
let CONFIG_PATH: string;
let startServer: (typeof import("./server.js"))["startServer"];

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

/** A proposal rerankAll() promotes open→critical: one high-severity signal,
 *  count 10 ⇒ score 80 ≥ criticalScore 60 (mirrors the triage-spawn fixture). */
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
  handle = await shared.createTestDb({ label: "fri142_evolve_notify" });
  CONFIG_PATH = shared.CONFIG_PATH;

  const evolve = await import("@friday/evolve");
  saveProposal = evolve.saveProposal;

  ({ startServer } = await import("./server.js"));
});

afterAll(async () => {
  await handle.drop();
});

describe("POST /api/evolve/scan — evolve_critical seam (#5)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    await handle.truncate();
    // No evolve auto-spawn flags ⇒ the seam is the only thing exercised.
    writeFileSync(CONFIG_PATH, JSON.stringify({ orchestratorName: "friday" }) + "\n");
    ({ server, port } = await startOnFreePort());
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    notifySpy.mockClear();
  });

  it("fires evolve_critical EXACTLY once when a proposal promotes to critical", async () => {
    fixtureProposal("daemon worker exit loop CRIT");

    const res = await fetch(scanUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeFriction: false, includePreferences: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { promotedFromRerank: number };
    // Sanity: the rerank surface actually promoted our fixture.
    expect(body.promotedFromRerank).toBeGreaterThanOrEqual(1);

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0]![0]).toMatchObject({
      type: "evolve_critical",
      title: "Critical evolve proposal",
      deepLink: "/evolve",
      priority: "critical",
    });
  });

  it("fires NOTHING on a scan with no critical promotion", async () => {
    // Drain the in-memory store of any still-critical proposal from the prior
    // test: a critical proposal stays critical across reranks, but rerank only
    // REPORTS newly-critical ones, so a second scan with the prior proposal
    // resolved to a terminal state promotes nothing. Reject it outright.
    await handle.truncate();
    // A fresh scan over an empty corpus: no signals, no proposals, no promotion.
    const res = await fetch(scanUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeFriction: false, includePreferences: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      promotedToCritical: number;
      promotedFromRerank: number;
    };
    expect(body.promotedToCritical).toBe(0);
    expect(body.promotedFromRerank).toBe(0);
    expect(notifySpy).not.toHaveBeenCalled();
  });
});
