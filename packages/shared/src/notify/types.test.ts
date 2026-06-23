// FRI-142 (ADR-048) — notification contract pins.
//
// DEFAULT_NOTIFY_POLICY is the truth a freshly-installed Friday's router
// resolves against (NULL notify_policy ⇒ this map). Downstream daemon
// (resolver) + dashboard (Settings presets) both derive from it, so pin the
// EXACT rule per (event, channel) — a silent edit here changes every default
// install's notification behavior.

import { describe, expect, it } from "vitest";
import { CHANNELS, DEFAULT_NOTIFY_POLICY, DELIVERY_RULES, NOTIFY_EVENT_TYPES } from "./types.js";

describe("FRI-142 notify taxonomy tuples", () => {
  it("NOTIFY_EVENT_TYPES is exactly the five ADR-048 event ids, in order", () => {
    expect(NOTIFY_EVENT_TYPES).toEqual([
      "capture_attention",
      "builder_archive",
      "schedule_fired",
      "mail_delivered",
      "evolve_critical",
    ]);
  });

  it("CHANNELS is exactly [toast, push] (the bell is NOT a channel)", () => {
    expect(CHANNELS).toEqual(["toast", "push"]);
  });

  it("DELIVERY_RULES is exactly the four presence-based rules", () => {
    expect(DELIVERY_RULES).toEqual(["never", "present_only", "absent_only", "always"]);
  });
});

describe("FRI-142 DEFAULT_NOTIFY_POLICY (the ADR-048 defaults)", () => {
  it("matches the ADR-048 default map exactly", () => {
    expect(DEFAULT_NOTIFY_POLICY).toEqual({
      capture_attention: { toast: "present_only", push: "absent_only" },
      builder_archive: { toast: "present_only", push: "absent_only" },
      schedule_fired: { toast: "present_only", push: "absent_only" },
      mail_delivered: { toast: "present_only", push: "never" },
      evolve_critical: { toast: "always", push: "always" },
    });
  });

  it("defines a rule for every (event, channel) pair (no holes the resolver must fill)", () => {
    for (const ev of NOTIFY_EVENT_TYPES) {
      for (const ch of CHANNELS) {
        expect(DELIVERY_RULES).toContain(DEFAULT_NOTIFY_POLICY[ev][ch]);
      }
    }
  });

  it("mail_delivered never pushes by default (low-stakes; no phone buzz)", () => {
    expect(DEFAULT_NOTIFY_POLICY.mail_delivered.push).toBe("never");
  });

  it("evolve_critical always fires both channels (critical reaches Seth)", () => {
    expect(DEFAULT_NOTIFY_POLICY.evolve_critical).toEqual({ toast: "always", push: "always" });
  });
});
