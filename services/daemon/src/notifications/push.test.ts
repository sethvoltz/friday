/**
 * FRI-142 / ADR-048 — Push storage + send path (Daemon-A).
 *
 * The bug class these own:
 *   - `push_subscriptions` upsert must dedup by the unique `endpoint` (a
 *     re-subscribe of the same endpoint refreshes keys/device, never duplicates).
 *   - A 410 (Gone) from the push service must DELETE the stale subscription row
 *     so the daemon stops hammering a dead endpoint.
 *   - The push payload must be TERSE — title/body/badge/deepLink/eventType only,
 *     NO chat content / PII leakage.
 *   - The badge count must equal the OPEN ATTENTION-worthy `inbox_items`
 *     (`state='open'` AND `kind IN ('proposed','unsorted')`) — a pinned number
 *     over a seeded set, with `done`/`resolved` rows excluded.
 *
 * Tested at the repository/send layer with a stateful in-memory `getDb()` mock
 * (the network/IO boundary) and a mocked `web-push` send — reactivity/logic stay
 * real, assertions pin observable post-state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- In-memory tables the mocked getDb() reads/writes. ---------------------
interface PushRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userId: string;
  deviceId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}
interface InboxRow {
  id: string;
  state: string;
  kind: string;
}

let pushRows: PushRow[] = [];
let inboxRows: InboxRow[] = [];

// Predicate descriptors emitted by the mocked drizzle-orm helpers.
type Pred =
  | { op: "eq"; col: string; val: unknown }
  | { op: "in"; col: string; vals: unknown[] }
  | { op: "and"; preds: Pred[] };

function matches(row: Record<string, unknown>, pred: Pred | null): boolean {
  if (pred == null) return true;
  if (pred.op === "eq") return row[pred.col] === pred.val;
  if (pred.op === "in") return pred.vals.includes(row[pred.col]);
  return pred.preds.every((p) => matches(row, p));
}

/**
 * Chainable mock matching the exact call shapes the modules use:
 *   db.insert(push).values(v).onConflictDoUpdate({ target, set })  — upsert
 *   db.select().from(push).where(eq(userId, X))                    — list-by-user
 *   db.delete(push).where(eq(endpoint, X) | and(...))              — cleanup/drop
 *   db.select({ n: count() }).from(inbox).where(and(eq, inArray))  — badge count
 * The table the call targets is identified by a `__table` tag on the schema
 * descriptor the mocked schema provides.
 */
function makeDb() {
  return {
    insert: (table: { __table: string }) => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: ({ set }: { target: unknown; set: Record<string, unknown> }) => {
          if (table.__table === "push_subscriptions") {
            const existing = pushRows.find((r) => r.endpoint === v.endpoint);
            if (existing) {
              Object.assign(existing, set);
            } else {
              pushRows.push({ id: `id-${pushRows.length + 1}`, ...(v as object) } as PushRow);
            }
          }
          return Promise.resolve(undefined);
        },
      }),
    }),
    select: (_proj?: unknown) => ({
      from: (table: { __table: string }) => {
        let pred: Pred | null = null;
        const source = (): Record<string, unknown>[] =>
          table.__table === "push_subscriptions" ? (pushRows as never) : (inboxRows as never);
        const builder = {
          where: (p: Pred) => {
            pred = p;
            const filtered = source().filter((r) => matches(r, pred));
            // Aggregate (badge `select({ n: count() })`) returns [{ n }]; plain
            // select returns the filtered rows. Disambiguated by whether a
            // projection object was passed to `select`.
            if (_proj && typeof _proj === "object") {
              return Promise.resolve([{ n: filtered.length }]);
            }
            return Promise.resolve(filtered);
          },
        };
        return builder;
      },
    }),
    delete: (table: { __table: string }) => ({
      where: (p: Pred) => {
        if (table.__table === "push_subscriptions") {
          pushRows = pushRows.filter((r) => !matches(r as never, p));
        }
        return Promise.resolve(undefined);
      },
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
      pushSubscriptions: {
        __table: "push_subscriptions",
        endpoint: { key: "endpoint" },
        userId: { key: "userId" },
        deviceId: { key: "deviceId" },
      },
      inboxItems: {
        __table: "inbox_items",
        state: { key: "state" },
        kind: { key: "kind" },
      },
    },
  };
});

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: { key: string }, val: unknown) => ({ op: "eq" as const, col: col.key, val }),
    inArray: (col: { key: string }, vals: unknown[]) => ({
      op: "in" as const,
      col: col.key,
      vals,
    }),
    and: (...preds: Pred[]) => ({ op: "and" as const, preds }),
    count: () => ({ __agg: "count" }),
  };
});

vi.mock("../log.js", () => ({ logger: { log: vi.fn() } }));

// `web-push`: send is a spy a test arms to resolve or throw a WebPushError.
// `WebPushError` must remain a real constructor so `instanceof` in push-send.ts
// holds; only `sendNotification` / `setVapidDetails` / `generateVAPIDKeys` are
// stubbed.
const sendSpy = vi.fn<(sub: unknown, payload: string) => Promise<void>>();
vi.mock("web-push", () => ({
  default: {
    sendNotification: (sub: unknown, payload: string) => sendSpy(sub, payload),
    setVapidDetails: vi.fn(),
    generateVAPIDKeys: () => ({ publicKey: "PUB", privateKey: "PRIV" }),
  },
  WebPushError: class extends Error {
    statusCode: number;
    endpoint: string;
    constructor(message: string, statusCode: number, endpoint: string) {
      super(message);
      this.statusCode = statusCode;
      this.endpoint = endpoint;
    }
  },
}));

// Keep VAPID off the disk entirely in this suite — `ensureVapidConfigured` is
// exercised only as a no-op precondition of the send fan-out.
vi.mock("./vapid.js", () => ({
  // Async now — the keypair lives in Postgres (web_push_vapid), so the
  // configure/ensure path returns a Promise. push-send awaits it.
  ensureVapidKeys: vi.fn(async () => ({ publicKey: "PUB", privateKey: "PRIV" })),
  ensureVapidConfigured: vi.fn(async () => ({ publicKey: "PUB", privateKey: "PRIV" })),
  getVapidPublicKey: vi.fn(async () => "PUB"),
}));

import {
  upsertSubscription,
  listSubscriptionsForUser,
  deleteSubscriptionByEndpoint,
  dropSubscriptionsForDevice,
} from "./push-subscriptions.js";
import { computeBadgeCount } from "./badge.js";
import { buildPushPayload, sendToSubscription, sendPushToUser } from "./push-send.js";
import type { NotifyEvent, PushSubscribePayload } from "@friday/shared";
// The real WebPushError class (the mock returns a real constructor), so a thrown
// instance satisfies the `instanceof WebPushError` guard in push-send.ts.
import { WebPushError } from "web-push";

function sub(over: Partial<PushSubscribePayload> = {}): PushSubscribePayload {
  return {
    endpoint: "https://push.example/ep-1",
    keys: { p256dh: "p256-1", auth: "auth-1" },
    deviceId: "dev-1",
    ...over,
  };
}

beforeEach(() => {
  pushRows = [];
  inboxRows = [];
  sendSpy.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("upsertSubscription", () => {
  it("inserts a new row and dedups a re-subscribe by endpoint (no duplicate, keys refreshed)", async () => {
    await upsertSubscription(sub(), "user-1");
    expect(pushRows).toHaveLength(1);
    expect(pushRows[0]).toMatchObject({
      endpoint: "https://push.example/ep-1",
      p256dh: "p256-1",
      auth: "auth-1",
      userId: "user-1",
      deviceId: "dev-1",
    });

    // Same endpoint, rotated keys + device → updates in place, still ONE row.
    await upsertSubscription(
      sub({ keys: { p256dh: "p256-rotated", auth: "auth-rotated" }, deviceId: "dev-2" }),
      "user-1",
    );
    expect(pushRows).toHaveLength(1);
    expect(pushRows[0]).toMatchObject({
      endpoint: "https://push.example/ep-1",
      p256dh: "p256-rotated",
      auth: "auth-rotated",
      deviceId: "dev-2",
    });
  });

  it("keeps distinct endpoints as separate rows", async () => {
    await upsertSubscription(sub({ endpoint: "https://push.example/a" }), "user-1");
    await upsertSubscription(sub({ endpoint: "https://push.example/b" }), "user-1");
    expect(pushRows.map((r) => r.endpoint).sort()).toEqual([
      "https://push.example/a",
      "https://push.example/b",
    ]);
  });
});

describe("listSubscriptionsForUser", () => {
  it("returns only the queried user's subscriptions, projected for web-push", async () => {
    await upsertSubscription(sub({ endpoint: "https://push.example/u1" }), "user-1");
    await upsertSubscription(sub({ endpoint: "https://push.example/u2" }), "user-2");

    const out = await listSubscriptionsForUser("user-1");
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      endpoint: "https://push.example/u1",
      keys: { p256dh: "p256-1", auth: "auth-1" },
      userId: "user-1",
      deviceId: "dev-1",
    });
  });
});

describe("deleteSubscriptionByEndpoint", () => {
  it("removes the matching row and is a no-op for an unknown endpoint", async () => {
    await upsertSubscription(sub({ endpoint: "https://push.example/keep" }), "user-1");
    await upsertSubscription(sub({ endpoint: "https://push.example/drop" }), "user-1");

    await deleteSubscriptionByEndpoint("https://push.example/drop");
    expect(pushRows.map((r) => r.endpoint)).toEqual(["https://push.example/keep"]);

    // No-op on a non-existent endpoint.
    await deleteSubscriptionByEndpoint("https://push.example/never");
    expect(pushRows.map((r) => r.endpoint)).toEqual(["https://push.example/keep"]);
  });
});

describe("dropSubscriptionsForDevice", () => {
  it("drops every subscription for a device scoped to its user (the Forget-this-device cascade)", async () => {
    await upsertSubscription(
      sub({ endpoint: "https://push.example/d1a", deviceId: "dev-X" }),
      "user-1",
    );
    await upsertSubscription(
      sub({ endpoint: "https://push.example/d1b", deviceId: "dev-X" }),
      "user-1",
    );
    await upsertSubscription(
      sub({ endpoint: "https://push.example/d2", deviceId: "dev-Y" }),
      "user-1",
    );
    // Same deviceId string but a different user must NOT be dropped.
    await upsertSubscription(
      sub({ endpoint: "https://push.example/other", deviceId: "dev-X" }),
      "user-2",
    );

    await dropSubscriptionsForDevice("dev-X", "user-1");

    expect(pushRows.map((r) => r.endpoint).sort()).toEqual([
      "https://push.example/d2",
      "https://push.example/other",
    ]);
  });
});

describe("computeBadgeCount", () => {
  it("counts ONLY open attention-worthy items (proposed/unsorted), excluding done + resolved", async () => {
    inboxRows = [
      { id: "1", state: "open", kind: "proposed" }, // counts
      { id: "2", state: "open", kind: "unsorted" }, // counts
      { id: "3", state: "open", kind: "proposed" }, // counts
      { id: "4", state: "open", kind: "done" }, // FYI — excluded
      { id: "5", state: "resolved", kind: "proposed" }, // resolved — excluded
      { id: "6", state: "resolved", kind: "unsorted" }, // resolved — excluded
    ];
    expect(await computeBadgeCount()).toBe(3);
  });

  it("is 0 with no attention-worthy items", async () => {
    inboxRows = [
      { id: "1", state: "open", kind: "done" },
      { id: "2", state: "resolved", kind: "proposed" },
    ];
    expect(await computeBadgeCount()).toBe(0);
  });
});

const baseEvent: NotifyEvent = {
  type: "builder_archive",
  title: "Builder finished",
  body: "Your branch is ready to review",
  deepLink: "/agents/scratch-42",
};

describe("buildPushPayload (terseness)", () => {
  it("emits ONLY title/body/badge/deepLink/eventType and stamps the recomputed badge", async () => {
    inboxRows = [
      { id: "1", state: "open", kind: "proposed" },
      { id: "2", state: "open", kind: "unsorted" },
    ];
    const payload = await buildPushPayload(baseEvent);

    expect(payload).toEqual({
      title: "Builder finished",
      body: "Your branch is ready to review",
      badge: 2,
      deepLink: "/agents/scratch-42",
      eventType: "builder_archive",
    });
    // Exhaustive key pin — guards against PII / chat-content leakage sneaking in.
    expect(Object.keys(payload).sort()).toEqual([
      "badge",
      "body",
      "deepLink",
      "eventType",
      "title",
    ]);
  });

  it("omits deepLink entirely when the event has none (never serializes a null link)", async () => {
    const payload = await buildPushPayload({
      type: "mail_delivered",
      title: "Mail",
      body: "1 new",
    });
    expect("deepLink" in payload).toBe(false);
    expect(Object.keys(payload).sort()).toEqual(["badge", "body", "eventType", "title"]);
  });
});

describe("sendToSubscription — stale cleanup", () => {
  it("deletes the subscription row on a 410 (Gone) and reports 'stale'", async () => {
    await upsertSubscription(sub({ endpoint: "https://push.example/gone" }), "user-1");
    expect(pushRows).toHaveLength(1);

    sendSpy.mockRejectedValueOnce(new WebPushError("gone", 410, "https://push.example/gone"));

    const outcome = await sendToSubscription(
      {
        endpoint: "https://push.example/gone",
        keys: { p256dh: "p", auth: "a" },
        userId: "user-1",
        deviceId: "dev-1",
      },
      { title: "t", body: "b", badge: 0, eventType: "builder_archive" },
    );

    expect(outcome).toBe("stale");
    // Row count for that endpoint goes to 0.
    expect(pushRows.filter((r) => r.endpoint === "https://push.example/gone")).toHaveLength(0);
  });

  it("deletes the subscription row on a 404 (Not Found) too", async () => {
    await upsertSubscription(sub({ endpoint: "https://push.example/nf" }), "user-1");
    sendSpy.mockRejectedValueOnce(new WebPushError("nf", 404, "https://push.example/nf"));

    const outcome = await sendToSubscription(
      {
        endpoint: "https://push.example/nf",
        keys: { p256dh: "p", auth: "a" },
        userId: "user-1",
        deviceId: "dev-1",
      },
      { title: "t", body: "b", badge: 0, eventType: "builder_archive" },
    );

    expect(outcome).toBe("stale");
    expect(pushRows).toHaveLength(0);
  });

  it("KEEPS the row on a transient (500) failure and reports 'error'", async () => {
    await upsertSubscription(sub({ endpoint: "https://push.example/flaky" }), "user-1");
    sendSpy.mockRejectedValueOnce(new WebPushError("oops", 500, "https://push.example/flaky"));

    const outcome = await sendToSubscription(
      {
        endpoint: "https://push.example/flaky",
        keys: { p256dh: "p", auth: "a" },
        userId: "user-1",
        deviceId: "dev-1",
      },
      { title: "t", body: "b", badge: 0, eventType: "builder_archive" },
    );

    expect(outcome).toBe("error");
    // A transient failure must NOT drop a live subscription.
    expect(pushRows).toHaveLength(1);
  });

  it("reports 'sent' on success and serializes the exact terse payload to web-push", async () => {
    sendSpy.mockResolvedValueOnce(undefined);
    const payload = { title: "t", body: "b", badge: 5, eventType: "builder_archive" as const };

    const outcome = await sendToSubscription(
      {
        endpoint: "https://push.example/ok",
        keys: { p256dh: "pk", auth: "ak" },
        userId: "user-1",
        deviceId: "dev-1",
      },
      payload,
    );

    expect(outcome).toBe("sent");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [sentSub, sentBody] = sendSpy.mock.calls[0]!;
    expect(sentSub).toEqual({
      endpoint: "https://push.example/ok",
      keys: { p256dh: "pk", auth: "ak" },
    });
    expect(JSON.parse(sentBody as string)).toEqual(payload);
  });
});

describe("sendPushToUser — fan-out", () => {
  it("sends to every registration, recomputes the badge once, and tallies stale cleanup", async () => {
    await upsertSubscription(sub({ endpoint: "https://push.example/live" }), "user-1");
    await upsertSubscription(sub({ endpoint: "https://push.example/dead" }), "user-1");
    inboxRows = [{ id: "1", state: "open", kind: "proposed" }];

    // First send OK, second 410 (stale → deleted).
    sendSpy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new WebPushError("gone", 410, "https://push.example/dead"));

    const tally = await sendPushToUser("user-1", baseEvent);

    expect(tally).toEqual({ sent: 1, stale: 1, error: 0 });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    // The dead endpoint's row was cleaned up; the live one remains.
    expect(pushRows.map((r) => r.endpoint)).toEqual(["https://push.example/live"]);

    // Badge stamped into the payload equals the open attention-worthy count (1).
    const firstBody = JSON.parse(sendSpy.mock.calls[0]![1] as string) as { badge: number };
    expect(firstBody.badge).toBe(1);
  });

  it("is a no-op (zero sends) when the user has no subscriptions", async () => {
    const tally = await sendPushToUser("nobody", baseEvent);
    expect(tally).toEqual({ sent: 0, stale: 0, error: 0 });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
