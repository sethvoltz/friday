/**
 * FRI-142 / ADR-048 — Pure policy × presence × DND resolver.
 *
 * The falsification gate for AC5 (policy resolution), AC6 (DND + critical
 * bypass), and AC9 (presence-unknown ⇒ absent ⇒ push). This is the PURE
 * function the router delegates the channel decision to — so every gate branch
 * is pinned here with EXACT `{ toast, push }` outputs over explicit inputs (no
 * DB, no SSE, no clock IO). The router's own test then only has to verify it
 * wires the right inputs in and fires the resolved channels.
 */

import { describe, expect, it } from "vitest";
import type { NotifyPolicy } from "@friday/shared";
import { resolveChannels, effectiveRule, isInDndWindow } from "./policy.js";

const NO_DND = { inDnd: false, critical: false, criticalBypassDnd: true };

describe("effectiveRule — stored policy overlaid on the default", () => {
  it("returns the stored rule when present and the default when absent (partial at both levels)", () => {
    const policy: NotifyPolicy = { mail_delivered: { toast: "always" } };
    // Stored override wins.
    expect(effectiveRule(policy, "mail_delivered", "toast")).toBe("always");
    // Channel not in the stored event key → default (mail_delivered.push = never).
    expect(effectiveRule(policy, "mail_delivered", "push")).toBe("never");
    // Event not in the stored policy at all → default (builder_archive defaults).
    expect(effectiveRule(policy, "builder_archive", "toast")).toBe("present_only");
    expect(effectiveRule(policy, "builder_archive", "push")).toBe("absent_only");
  });
});

describe("resolveChannels — the four DeliveryRules × presence (AC5)", () => {
  it("default mail_delivered with toast:'never'/push:'never' fires ZERO channels, present or absent", () => {
    const policy: NotifyPolicy = { mail_delivered: { toast: "never", push: "never" } };
    expect(
      resolveChannels({ eventType: "mail_delivered", present: true, policy, ...NO_DND }),
    ).toEqual({ toast: false, push: false });
    expect(
      resolveChannels({ eventType: "mail_delivered", present: false, policy, ...NO_DND }),
    ).toEqual({ toast: false, push: false });
  });

  it("builder_archive.push:'always' fires Push EVEN when present (AC5: always ignores presence)", () => {
    const policy: NotifyPolicy = { builder_archive: { push: "always" } };
    const present = resolveChannels({
      eventType: "builder_archive",
      present: true,
      policy,
      ...NO_DND,
    });
    expect(present.push).toBe(true);
    // toast defaults to present_only → fires while present.
    expect(present.toast).toBe(true);
  });

  it("present_only fires only when present; absent_only fires only when absent", () => {
    // Default builder_archive: toast present_only, push absent_only.
    const whenPresent = resolveChannels({
      eventType: "builder_archive",
      present: true,
      policy: {},
      ...NO_DND,
    });
    expect(whenPresent).toEqual({ toast: true, push: false });

    const whenAbsent = resolveChannels({
      eventType: "builder_archive",
      present: false,
      policy: {},
      ...NO_DND,
    });
    expect(whenAbsent).toEqual({ toast: false, push: true });
  });

  it("AC9: presence-unknown is passed in as absent ⇒ an absent_only push fires (fail-safe over-push)", () => {
    // The router maps unknown/empty presence to `present:false`; here we assert
    // the resolver's half: absent ⇒ the default absent_only push fires.
    const decision = resolveChannels({
      eventType: "capture_attention",
      present: false,
      policy: {},
      ...NO_DND,
    });
    expect(decision.push).toBe(true);
  });

  it("never fully suppresses regardless of presence; always fully fires regardless of presence", () => {
    const policy: NotifyPolicy = {
      schedule_fired: { toast: "never", push: "always" },
    };
    for (const present of [true, false]) {
      expect(resolveChannels({ eventType: "schedule_fired", present, policy, ...NO_DND })).toEqual({
        toast: false,
        push: true,
      });
    }
  });
});

describe("resolveChannels — DND overlay + critical bypass (AC6)", () => {
  const dndPushAlways: NotifyPolicy = {
    builder_archive: { push: "always", toast: "always" },
    evolve_critical: { push: "always", toast: "always" },
  };

  it("inside DND, push is SUPPRESSED for a non-critical event even when the rule says always", () => {
    const decision = resolveChannels({
      eventType: "builder_archive",
      present: false,
      policy: dndPushAlways,
      inDnd: true,
      critical: false,
      criticalBypassDnd: true,
    });
    expect(decision.push).toBe(false);
    // DND never touches Toast — the toast still fires.
    expect(decision.toast).toBe(true);
  });

  it("inside DND, a CRITICAL event with bypass ON still resolves to push", () => {
    const decision = resolveChannels({
      eventType: "evolve_critical",
      present: false,
      policy: dndPushAlways,
      inDnd: true,
      critical: true,
      criticalBypassDnd: true,
    });
    expect(decision.push).toBe(true);
  });

  it("inside DND, a CRITICAL event with bypass OFF is suppressed (the toggle is load-bearing)", () => {
    const decision = resolveChannels({
      eventType: "evolve_critical",
      present: false,
      policy: dndPushAlways,
      inDnd: true,
      critical: true,
      criticalBypassDnd: false,
    });
    expect(decision.push).toBe(false);
  });

  it("OUTSIDE DND, the critical bypass toggle has no effect — push fires by policy alone", () => {
    const decision = resolveChannels({
      eventType: "builder_archive",
      present: false,
      policy: dndPushAlways,
      inDnd: false,
      critical: false,
      criticalBypassDnd: false,
    });
    expect(decision.push).toBe(true);
  });
});

describe("isInDndWindow", () => {
  it("returns false when either bound is null (no DND configured)", () => {
    expect(isInDndWindow("23:30", null, "07:00")).toBe(false);
    expect(isInDndWindow("23:30", "22:00", null)).toBe(false);
    expect(isInDndWindow("23:30", null, null)).toBe(false);
  });

  it("same-day window [start,end): inside iff start ≤ now < end", () => {
    expect(isInDndWindow("13:00", "12:00", "14:00")).toBe(true);
    expect(isInDndWindow("12:00", "12:00", "14:00")).toBe(true); // exact start = inside
    expect(isInDndWindow("14:00", "12:00", "14:00")).toBe(false); // exact end = outside
    expect(isInDndWindow("11:59", "12:00", "14:00")).toBe(false);
  });

  it("crosses midnight (start > end): inside iff now ≥ start OR now < end", () => {
    // 22:00 → 07:00 overnight window.
    expect(isInDndWindow("23:30", "22:00", "07:00")).toBe(true);
    expect(isInDndWindow("02:00", "22:00", "07:00")).toBe(true);
    expect(isInDndWindow("06:59", "22:00", "07:00")).toBe(true);
    expect(isInDndWindow("07:00", "22:00", "07:00")).toBe(false); // exact end
    expect(isInDndWindow("12:00", "22:00", "07:00")).toBe(false); // midday
    expect(isInDndWindow("21:59", "22:00", "07:00")).toBe(false);
  });

  it("zero-length window (start === end) is never in DND", () => {
    expect(isInDndWindow("08:00", "08:00", "08:00")).toBe(false);
  });

  it("malformed time strings resolve to not-in-DND (fail-open)", () => {
    expect(isInDndWindow("nope", "22:00", "07:00")).toBe(false);
    expect(isInDndWindow("12:00", "bad", "07:00")).toBe(false);
  });
});
