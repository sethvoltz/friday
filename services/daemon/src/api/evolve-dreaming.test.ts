/**
 * FRI-26 Memory Dreaming — integration tests for the dreaming sub-pass wired
 * into `POST /api/evolve/scan` (design D7 / D9).
 *
 * Patterned after evolve-triage-spawn.test.ts: createTestDb + startServer({
 * port: 0 }) + fetch. Key mechanics:
 *
 *  - FRIDAY_DATA_DIR is set to a fresh tmpdir at the TOP of the file, BEFORE
 *    any @friday import, so CONFIG_PATH / the evolve proposals dir / the memory
 *    entries dir all bind to the scratch tree (per CLAUDE.md).
 *  - ONLY the LLM-backed scanner is mocked: `vi.mock("@friday/evolve")` replaces
 *    `scanDreaming` with a stub returning a CANNED Signal[] built with the REAL
 *    `bucketByCandidate` + `encodeDreamPayload` (via vi.importActual), so the
 *    payloads decode correctly downstream. EVERYTHING else runs REAL against the
 *    scratch DB: proposeFromSignals → draftFromSignal+decode → applyDreamProposals
 *    → applyProposal/searchMemories/updateEntry → runHygiene → appendDreamEntry.
 *  - Proposals are asserted via the file-backed evolve store (listProposals /
 *    getProposal); memory entries via the memory store (getEntry / listEntries).
 *
 * scoreProposal arithmetic (single dream signal, blastRadius "low" → penalty 0):
 *   score = SEVERITY_WEIGHT[severity] + min(40, log2(totalCount + 1) * 12)
 *   high = 40, medium = 20, low = 5.
 * Fixtures are engineered so:
 *   - feedback / signal_score 5 (high) recurring 3× → count 3 → 40 + min(40,
 *     log2(4)*12 = 24) = 64  (clears feedback:60, NOT person:80).
 *   - person  / signal_score 5 (high) recurring 10× → count 10 → 40 + min(40,
 *     log2(11)*12 = 41.5 → 40) = 80  (clears person:80).
 *   - person  / signal_score 5 (high) recurring 3× → count 3 → 64  (< person:80).
 *   - reference / signal_score 3 (medium) single turn → count 1 → 20 + 12 = 32
 *     (below every category bar → stays open).
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

const DATA_DIR = mkdtempSync(join(tmpdir(), "fri26-dreaming-"));
process.env.FRIDAY_DATA_DIR = DATA_DIR;
// Quiet the logger's stdout mirror so the test output stays clean.
process.env.FRIDAY_LOG_STDOUT = "off";
// FRI-24 embed FAKE mode (same as embed.e2e.test.ts): the scratch FRIDAY_DATA_DIR
// has no cached ONNX model, so a REAL embed would attempt a HuggingFace download
// (multi-second hang / network) on the FIRST searchMemories the dreaming hook
// runs. FAKE mode keeps the REAL fork + IPC round-trip but replies with a
// deterministic offline pseudo-embedding — searchMemories' FTS tag/title scoring
// (which drives the dream dedup at score >= 5) is unaffected.
process.env.FRIDAY_EMBED_FAKE = "1";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OrchestratorTurn, DreamScoredCandidate, Signal } from "@friday/evolve";

// ───────────────────────────────────────────────────────────────────────────
// CANNED dream signals. Built with the REAL bucketByCandidate + encodeDreamPayload
// so they carry a decodable DreamPayload. `vi.mock` below swaps ONLY scanDreaming
// for a stub returning these; the rest of @friday/evolve stays real.
// ───────────────────────────────────────────────────────────────────────────
let CANNED: Signal[] = [];

// The dreaming sub-pass scanner. FRI-174 moved the scan→propose→…→dream spine
// into `runEvolveCycle` (a deep module shared with the CLI), whose COMPILED body
// imports `scanDreaming` from the package-internal `./scan-dreaming.js` — NOT via
// the `@friday/evolve` barrel. So mocking the barrel alone no longer intercepts
// the call. We mock BOTH: the barrel (for the bits the test imports + asserts
// against) AND the dist-internal module that `runEvolveCycle` actually calls,
// pointing both at the same per-test CANNED stub. Everything else downstream
// (proposeFromSignals → applyDreamProposals → applyProposal/searchMemories/
// updateEntry → runHygiene → appendDreamEntry) stays REAL.
const scanDreamingStub = vi.fn(async () => CANNED);

vi.mock("@friday/evolve", async (orig) => {
  const real = await orig<typeof import("@friday/evolve")>();
  return {
    ...real,
    // The endpoint calls scanDreaming({ since, evidence }); we ignore both and
    // return the per-test CANNED array (closure-captured `let`, re-assigned in
    // each describe's beforeAll).
    scanDreaming: scanDreamingStub,
  };
});

// The module identity `runEvolveCycle` imports internally. Keep the real
// encode/decode (propose.ts depends on decodeDreamPayload) — replace ONLY
// scanDreaming with the same stub.
vi.mock("@friday/evolve/scan-dreaming", async (orig) => {
  const real = await orig<typeof import("@friday/evolve/scan-dreaming")>();
  return { ...real, scanDreaming: scanDreamingStub };
});

let handle: import("@friday/shared").TestDbHandle;
let CONFIG_PATH: string;
let startServer: (typeof import("./server.js"))["startServer"];

// Real evolve helpers used to BUILD the canned signals and to ASSERT proposals.
let bucketByCandidate: (typeof import("@friday/evolve"))["bucketByCandidate"];
let listProposals: (typeof import("@friday/evolve"))["listProposals"];
// The mocked scanDreaming, captured so the cursor test (AC6/F4) can inspect the
// `since` it was called with.
let scanDreamingMock: (typeof import("@friday/evolve"))["scanDreaming"];
// Real memory store used to ASSERT applied/extended entries.
let getEntry: (typeof import("@friday/memory"))["getEntry"];
let listEntries: (typeof import("@friday/memory"))["listEntries"];
let slugify: (typeof import("@friday/evolve"))["slugify"];

const CALLER = "scheduled-meta-daily";

/** Build one `OrchestratorTurn & DreamScoredCandidate` with sane defaults. */
function candidate(
  overrides: Partial<OrchestratorTurn & DreamScoredCandidate> &
    Pick<DreamScoredCandidate, "signal_score" | "category" | "proposed_title">,
): OrchestratorTurn & DreamScoredCandidate {
  const turnId = overrides.turnId ?? `turn-${Math.random().toString(36).slice(2, 8)}`;
  return {
    sessionId: "sess-1",
    filePath: "",
    turnId,
    ts: overrides.ts ?? "2026-06-20T12:00:00.000Z",
    userText: "user said something durable",
    prevAssistantText: "",
    dbTurnId: "1",
    reason: "fixture",
    proposed_content: "Durable fact body for the candidate memory.",
    proposed_tags: ["topic"],
    already_covered: false,
    ...overrides,
  };
}

/** N copies of a candidate (distinct turnIds, same proposed_title → same slug)
 *  so `bucketByCandidate` merges them into ONE signal with count === N. */
function recurring(
  n: number,
  base: Parameters<typeof candidate>[0],
): Array<OrchestratorTurn & DreamScoredCandidate> {
  const out: Array<OrchestratorTurn & DreamScoredCandidate> = [];
  for (let i = 0; i < n; i++) {
    out.push(candidate({ ...base, turnId: `${base.proposed_title}-${i}` }));
  }
  return out;
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

/** POST /api/evolve/scan with friction/preferences off (so only dream signals
 *  flow), as the caller `scheduled-meta-daily`. */
async function postScan(port: number): Promise<Response> {
  return fetch(scanUrl(port), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-friday-caller-name": CALLER,
    },
    body: JSON.stringify({ includeFriction: false, includePreferences: false }),
  });
}

beforeAll(async () => {
  mkdirSync(join(DATA_DIR, "logs"), { recursive: true });
  writeFileSync(join(DATA_DIR, "logs", "daemon.jsonl"), "");

  const shared = await import("@friday/shared");
  handle = await shared.createTestDb({ label: "fri26_dreaming" });
  CONFIG_PATH = shared.CONFIG_PATH;

  const evolve = await import("@friday/evolve");
  bucketByCandidate = evolve.bucketByCandidate;
  listProposals = evolve.listProposals;
  slugify = evolve.slugify;
  scanDreamingMock = evolve.scanDreaming;

  const memory = await import("@friday/memory");
  getEntry = memory.getEntry;
  listEntries = memory.listEntries;

  ({ startServer } = await import("./server.js"));
});

afterAll(async () => {
  await handle.drop();
});

// ───────────────────────────────────────────────────────────────────────────
// AC2 + AC3 + AC5: a mixed run that creates dream proposals, auto-applies one
// that clears its category bar, and leaves a below-bar one open.
// ───────────────────────────────────────────────────────────────────────────
describe("POST /api/evolve/scan dreaming — proposals, auto-apply, open (AC2/AC3/AC5)", () => {
  let server: Server;
  let port: number;

  const feedbackTitle = "Seth deploys via friday update";
  const referenceTitle = "Grafana dashboard url for friday metrics";

  beforeAll(async () => {
    await handle.truncate();
    writeFileSync(CONFIG_PATH, JSON.stringify({ orchestratorName: "friday" }) + "\n");
    ({ server, port } = await startOnFreePort());

    // feedback, high severity, count 3 → score 64 ≥ feedback:60 → auto-applies.
    const feedback = recurring(3, {
      signal_score: 5,
      category: "feedback",
      proposed_title: feedbackTitle,
      proposed_content: "Always deploy Friday via `friday update`, never brew.",
      proposed_tags: ["deploy", "friday-update"],
    });
    // reference, medium severity, single turn → score 32 < reference:45 → open.
    const reference = [
      candidate({
        signal_score: 3,
        category: "reference",
        proposed_title: referenceTitle,
        proposed_content: "Friday metrics live on the Grafana ops dashboard.",
        proposed_tags: ["grafana", "metrics"],
      }),
    ];
    CANNED = bucketByCandidate([...feedback, ...reference]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("creates type:'memory' dream proposals tagged memory:dreaming + category, body carries content+tags (AC2)", async () => {
    const res = await postScan(port);
    expect(res.status).toBe(200);
    const summary = (await res.json()) as {
      dreamPromoted: number;
      dreamReinforced: number;
      dreamMerged: number;
      dreamFlagged: number;
    };
    // One auto-applied (feedback); the reference candidate stays open.
    expect(summary).toMatchObject({ dreamPromoted: 1, dreamReinforced: 0 });

    const proposals = listProposals();
    const fb = proposals.find((p) => p.title === feedbackTitle);
    const ref = proposals.find((p) => p.title === referenceTitle);
    expect(fb).toBeDefined();
    expect(ref).toBeDefined();

    // AC2: type === "memory" and appliesTo includes memory:dreaming + category.
    expect(fb?.type).toBe("memory");
    expect(fb?.appliesTo).toContain("memory:dreaming");
    expect(fb?.appliesTo).toContain("feedback");
    expect(ref?.appliesTo).toContain("memory:dreaming");
    expect(ref?.appliesTo).toContain("reference");

    // AC2/F12: proposedChange carries the proposed title heading AND the LLM
    // content AND the proposed tags line.
    expect(fb?.proposedChange).toContain(`# ${feedbackTitle}`);
    expect(fb?.proposedChange).toContain("Always deploy Friday via `friday update`, never brew.");
    expect(fb?.proposedChange).toContain("Proposed tags: deploy, friday-update");
  });

  it("auto-applies the feedback proposal: getEntry(slug) tagged evolve+feedback, createdBy === callerName (AC3)", async () => {
    const slug = slugify(feedbackTitle);
    const entry = await getEntry(slug);
    expect(entry).not.toBeNull();
    expect(entry?.tags).toContain("evolve");
    expect(entry?.tags).toContain("feedback");
    expect(entry?.tags).toContain("memory:dreaming");
    expect(entry?.createdBy).toBe(CALLER);
    // The applied memory body carries the canned content.
    expect(entry?.content).toContain("Always deploy Friday via `friday update`, never brew.");
  });

  it("leaves the below-threshold reference proposal 'open' with no memory row (AC5)", async () => {
    const ref = listProposals().find((p) => p.title === referenceTitle);
    expect(ref?.status).toBe("open");

    // No memory_entries row was written for the below-bar candidate.
    const refSlug = slugify(referenceTitle);
    expect(await getEntry(refSlug)).toBeNull();

    // It is surfaced via the proposals store (evolve_list source of truth).
    const open = listProposals().filter((p) => p.status === "open");
    expect(open.some((p) => p.title === referenceTitle)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC4: a second identical run dedup-extends instead of duplicating.
// ───────────────────────────────────────────────────────────────────────────
describe("POST /api/evolve/scan dreaming — second run dedup-extends (AC4)", () => {
  let server: Server;
  let port: number;
  const title = "Seth prefers pnpm over npm in monorepos";
  const slug = () => slugify(title);

  beforeAll(async () => {
    await handle.truncate();
    writeFileSync(CONFIG_PATH, JSON.stringify({ orchestratorName: "friday" }) + "\n");
    ({ server, port } = await startOnFreePort());

    // Single auto-applying candidate (user, high, count 10 → 80 ≥ user:55).
    CANNED = bucketByCandidate(
      recurring(10, {
        signal_score: 5,
        category: "user",
        proposed_title: title,
        proposed_content: "Seth uses pnpm exclusively across all monorepo workspaces.",
        proposed_tags: ["pnpm", "tooling"],
      }),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("first run creates one memory row; second identical run extends it (count unchanged, updatedAt advanced)", async () => {
    // Run 1: auto-applies, creating exactly one memory row.
    const res1 = await postScan(port);
    expect(res1.status).toBe(200);
    const sum1 = (await res1.json()) as { dreamPromoted: number; dreamReinforced: number };
    expect(sum1.dreamPromoted).toBe(1);
    expect(sum1.dreamReinforced).toBe(0);

    const afterRun1 = await listEntries();
    expect(afterRun1.length).toBe(1);
    const created = await getEntry(slug());
    expect(created).not.toBeNull();
    const updatedAt1 = created!.updatedAt;

    // Run 2: same CANNED → dedup hit → updateEntry extends, no new row.
    const res2 = await postScan(port);
    expect(res2.status).toBe(200);
    const sum2 = (await res2.json()) as { dreamPromoted: number; dreamReinforced: number };
    expect(sum2.dreamReinforced).toBe(1);

    const afterRun2 = await listEntries();
    // AC4: row count unchanged across the second run.
    expect(afterRun2.length).toBe(1);

    const extended = await getEntry(slug());
    expect(extended).not.toBeNull();
    // AC4/F11: updateEntry bumps updatedAt to a fresh ISO timestamp; the two
    // endpoint POSTs are a full HTTP + DB round-trip apart in wall-clock, so the
    // second is strictly later. Compare as epoch ms (toBeGreaterThan rejects
    // strings in Vitest 4); for ISO-8601 this is the same ordering as a
    // lexicographic compare.
    expect(Date.parse(extended!.updatedAt)).toBeGreaterThan(Date.parse(updatedAt1));
    // F11: the fold marker AND the (re-folded) proposed content both prove the
    // dedup-EXTEND path ran (updateEntry), not a fresh applyProposal — a bare
    // row-count check alone would pass even if the second run silently no-op'd.
    expect(extended!.content).toContain("---");
    expect(extended!.content).toContain(
      "Seth uses pnpm exclusively across all monorepo workspaces.",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC7a + AC7b: person gating at the 80 review bar.
// ───────────────────────────────────────────────────────────────────────────
describe("POST /api/evolve/scan dreaming — person review gate (AC7a/AC7b)", () => {
  let server: Server;
  let port: number;
  const belowTitle = "Dana Chen — Linear admin";
  const aboveTitle = "Mira Patel — design lead";

  beforeAll(async () => {
    await handle.truncate();
    writeFileSync(CONFIG_PATH, JSON.stringify({ orchestratorName: "friday" }) + "\n");
    ({ server, port } = await startOnFreePort());

    // person, high, count 3 → score 64 < person:80 → stays open.
    const below = recurring(3, {
      signal_score: 5,
      category: "person",
      proposed_title: belowTitle,
      proposed_content: "Dana Chen administers the Linear workspace.",
      proposed_tags: ["person", "person:dana-chen", "linear"],
    });
    // person, high, count 10 → score 80 ≥ person:80 → auto-applies.
    const above = recurring(10, {
      signal_score: 5,
      category: "person",
      proposed_title: aboveTitle,
      proposed_content: "Mira Patel leads design and owns the component library.",
      proposed_tags: ["person", "person:mira-patel", "design"],
    });
    CANNED = bucketByCandidate([...below, ...above]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("person below 80 stays open with NO memory row (AC7a)", async () => {
    const res = await postScan(port);
    expect(res.status).toBe(200);

    const belowSlug = slugify(belowTitle);
    // No memory row for the below-bar person.
    expect(await getEntry(belowSlug)).toBeNull();

    // Proposal ids are `<title-slug>-<suffix>` (store.generateId), not the
    // memory slug — look it up by title.
    const prop = listProposals().find((p) => p.title === belowTitle);
    expect(prop).toBeDefined();
    expect(prop?.status).toBe("open");
    expect(prop?.appliesTo).toContain("person");
    expect(prop?.appliesTo).toContain("memory:dreaming");
  });

  it("person at/above 80 auto-applies with evolve+person tags (AC7b)", async () => {
    const aboveSlug = slugify(aboveTitle);
    const entry = await getEntry(aboveSlug);
    expect(entry).not.toBeNull();
    expect(entry?.tags).toContain("evolve");
    expect(entry?.tags).toContain("person");
    expect(entry?.tags).toContain("memory:dreaming");
    expect(entry?.createdBy).toBe(CALLER);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC6 (F4): the dreaming cursor. The endpoint must honor a caller-supplied
// `sinceTs` (lastDreamScannedTs) by passing it straight through to scanDreaming's
// `since`, overriding the windowHours-derived window — proving the cursor is
// plumbed end-to-end (MCP tool → endpoint → scanner).
// ───────────────────────────────────────────────────────────────────────────
describe("POST /api/evolve/scan dreaming — honors the sinceTs cursor (AC6)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    await handle.truncate();
    writeFileSync(CONFIG_PATH, JSON.stringify({ orchestratorName: "friday" }) + "\n");
    ({ server, port } = await startOnFreePort());
    // No proposals needed — this test only inspects the `since` argument.
    CANNED = [];
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("passes the request's sinceTs straight through to scanDreaming({ since })", async () => {
    const sinceTs = "2026-06-01T00:00:00.000Z";
    vi.mocked(scanDreamingMock).mockClear();

    const res = await fetch(scanUrl(port), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-friday-caller-name": CALLER,
      },
      body: JSON.stringify({
        includeFriction: false,
        includePreferences: false,
        includeDreaming: true,
        sinceTs,
      }),
    });
    expect(res.status).toBe(200);

    // The endpoint computes `dreamSince = body.sinceTs ?? since` and forwards it
    // as scanDreaming's `since` — assert the EXACT cursor we posted reached it,
    // not the windowHours-derived default.
    expect(vi.mocked(scanDreamingMock)).toHaveBeenCalled();
    const firstCallArg = vi.mocked(scanDreamingMock).mock.calls[0]?.[0];
    expect(firstCallArg?.since).toBe(sinceTs);
  });
});
