/**
 * FRI-142 / ADR-048 — Server-side presence tracker.
 *
 * Stateful (an in-memory Map + a clock), so this exercises the real module
 * with an injected deterministic clock and asserts the OR-aggregation verdict
 * after each report — the bug class is: present iff ANY device is fresh AND
 * visible; absent requires EVERY device absent; stale (past TTL) / unknown /
 * empty ⇒ away (fail-safe over-push, AC9). The TTL-expiry interleaving is the
 * one that "works built forward" but must also break correctly on a stale beat.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../log.js", () => ({ logger: { log: vi.fn() } }));

import {
  reportPresence,
  isUserPresent,
  isAnyDevicePresent,
  PRESENCE_TTL_MS,
  __setPresenceClockForTest,
  __resetPresenceForTest,
} from "./presence.js";

// A controllable clock the module reads for `lastSeen` stamps + freshness.
let nowMs = 0;
beforeEach(() => {
  __resetPresenceForTest();
  nowMs = 1_000_000;
  __setPresenceClockForTest(() => nowMs);
});
afterEach(() => {
  __resetPresenceForTest();
});

describe("isUserPresent — OR-aggregation over a device set", () => {
  it("an empty device set is ABSENT (the restart / never-reported case ⇒ push)", () => {
    expect(isUserPresent([])).toBe(false);
    expect(isUserPresent(["unknown-device"])).toBe(false);
  });

  it("present iff ANY device is fresh AND visible (two devices)", () => {
    reportPresence({ deviceId: "dev-A", visible: false });
    reportPresence({ deviceId: "dev-B", visible: true });
    // dev-A hidden, dev-B visible → user present (OR).
    expect(isUserPresent(["dev-A", "dev-B"])).toBe(true);

    // Only dev-A in the set (hidden) → absent.
    expect(isUserPresent(["dev-A"])).toBe(false);
    // Only dev-B in the set (visible) → present.
    expect(isUserPresent(["dev-B"])).toBe(true);
  });

  it("ALL devices hidden ⇒ absent (requires every device absent)", () => {
    reportPresence({ deviceId: "dev-A", visible: false });
    reportPresence({ deviceId: "dev-B", visible: false });
    expect(isUserPresent(["dev-A", "dev-B"])).toBe(false);
  });

  it("a later report overwrites an earlier one for the same device (visible → hidden flips to absent)", () => {
    reportPresence({ deviceId: "dev-A", visible: true });
    expect(isUserPresent(["dev-A"])).toBe(true);
    reportPresence({ deviceId: "dev-A", visible: false });
    expect(isUserPresent(["dev-A"])).toBe(false);
  });
});

describe("isAnyDevicePresent — global presence for the broadcast toast", () => {
  it("is false on an empty Map and true once ANY device is fresh+visible", () => {
    expect(isAnyDevicePresent()).toBe(false);
    reportPresence({ deviceId: "dev-A", visible: false });
    expect(isAnyDevicePresent()).toBe(false); // hidden doesn't count
    reportPresence({ deviceId: "dev-B", visible: true });
    expect(isAnyDevicePresent()).toBe(true);
  });

  it("flips back to false when the only fresh device goes stale", () => {
    reportPresence({ deviceId: "dev-A", visible: true });
    expect(isAnyDevicePresent()).toBe(true);
    nowMs += PRESENCE_TTL_MS + 1;
    expect(isAnyDevicePresent()).toBe(false);
  });
});

describe("isUserPresent — TTL expiry (AC9 fail-safe)", () => {
  it("a visible device is present within TTL and ABSENT once the beat is stale", () => {
    reportPresence({ deviceId: "dev-A", visible: true });
    expect(isUserPresent(["dev-A"])).toBe(true);

    // Advance to exactly the TTL boundary — still fresh (≤ TTL).
    nowMs += PRESENCE_TTL_MS;
    expect(isUserPresent(["dev-A"])).toBe(true);

    // One ms past the TTL → stale → absent → push (fail-safe).
    nowMs += 1;
    expect(isUserPresent(["dev-A"])).toBe(false);
  });

  it("a single fresh device keeps the user present even if another's beat went stale (OR)", () => {
    reportPresence({ deviceId: "dev-A", visible: true });
    // 30s later, dev-B reports — dev-A is now older but still within TTL.
    nowMs += 30_000;
    reportPresence({ deviceId: "dev-B", visible: true });

    // Push dev-A past its TTL but keep dev-B fresh.
    nowMs += PRESENCE_TTL_MS - 30_000 + 1; // dev-A now stale, dev-B age = TTL-30s+1
    // dev-A stale, dev-B still fresh → user present via OR.
    expect(isUserPresent(["dev-A", "dev-B"])).toBe(true);
    // dev-A alone → absent.
    expect(isUserPresent(["dev-A"])).toBe(false);
  });
});
