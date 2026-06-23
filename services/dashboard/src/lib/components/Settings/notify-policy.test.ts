/**
 * FRI-142 (ADR-048) — preset sugar over the `notify_policy` rules.
 *
 * Pure mapping; pins EXACT rule pairs (the daemon router reads these verbatim,
 * so a wrong pair silently mis-delivers). Covers: each preset's materialized
 * {toast, push}; the overlay-on-default resolution; preset round-tripping
 * (apply → classify back); and the `auto`-wins-on-default + `custom` edge cases.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFY_POLICY, type NotifyPolicy } from "@friday/shared/sync";
import {
  applyPreset,
  criticalBypassMutatorArg,
  dndMutatorArg,
  presetForEvent,
  presetMutatorArg,
  resolveEffective,
  rulesForPreset,
} from "./notify-policy";

describe("rulesForPreset — exact materialized rule pairs", () => {
  it("toast_only ⇒ { toast: present_only, push: never }", () => {
    expect(rulesForPreset("toast_only", "builder_archive")).toEqual({
      toast: "present_only",
      push: "never",
    });
  });

  it("always_push ⇒ { toast: present_only, push: always }", () => {
    expect(rulesForPreset("always_push", "builder_archive")).toEqual({
      toast: "present_only",
      push: "always",
    });
  });

  it("off ⇒ { toast: never, push: never }", () => {
    expect(rulesForPreset("off", "builder_archive")).toEqual({
      toast: "never",
      push: "never",
    });
  });

  it("auto ⇒ the event's DEFAULT_NOTIFY_POLICY entry (per-event)", () => {
    // builder_archive default: toast present_only, push absent_only.
    expect(rulesForPreset("auto", "builder_archive")).toEqual({
      toast: "present_only",
      push: "absent_only",
    });
    // mail_delivered default differs: push never.
    expect(rulesForPreset("auto", "mail_delivered")).toEqual({
      toast: "present_only",
      push: "never",
    });
    // evolve_critical default: both always.
    expect(rulesForPreset("auto", "evolve_critical")).toEqual({
      toast: "always",
      push: "always",
    });
  });
});

describe("resolveEffective — overlay on default", () => {
  it("a null policy resolves every event to its default pair", () => {
    expect(resolveEffective(null, "schedule_fired")).toEqual(DEFAULT_NOTIFY_POLICY.schedule_fired);
  });

  it("a partial event override falls through per-channel to the default", () => {
    // Override only push for capture_attention; toast must still read default.
    const policy: NotifyPolicy = { capture_attention: { push: "always" } };
    expect(resolveEffective(policy, "capture_attention")).toEqual({
      toast: "present_only", // default
      push: "always", // override
    });
  });

  it("a full override wins over the default", () => {
    const policy: NotifyPolicy = { mail_delivered: { toast: "never", push: "never" } };
    expect(resolveEffective(policy, "mail_delivered")).toEqual({
      toast: "never",
      push: "never",
    });
  });
});

describe("applyPreset — produces the next full policy map", () => {
  it("writes the materialized pair for the chosen event, carrying others verbatim", () => {
    const prior: NotifyPolicy = { evolve_critical: { toast: "always", push: "always" } };
    const next = applyPreset(prior, "builder_archive", "toast_only");
    // Chosen event got the toast_only pair, fully materialized.
    expect(next.builder_archive).toEqual({ toast: "present_only", push: "never" });
    // Untouched event carried over unchanged.
    expect(next.evolve_critical).toEqual({ toast: "always", push: "always" });
  });

  it("does not mutate the input policy", () => {
    const prior: NotifyPolicy = { builder_archive: { toast: "always", push: "always" } };
    const snapshot = JSON.stringify(prior);
    applyPreset(prior, "builder_archive", "off");
    expect(JSON.stringify(prior)).toBe(snapshot);
  });
});

describe("presetForEvent — classify effective rules back to a preset", () => {
  it("a null policy reads as 'auto' (rules equal the default)", () => {
    expect(presetForEvent(null, "builder_archive")).toBe("auto");
  });

  it("round-trips every preset through apply → classify", () => {
    for (const preset of ["auto", "always_push", "toast_only", "off"] as const) {
      const next = applyPreset(null, "schedule_fired", preset);
      expect(presetForEvent(next, "schedule_fired")).toBe(preset);
    }
  });

  it("mail_delivered's default reads as 'auto', not 'toast_only', even though the pairs coincide", () => {
    // mail_delivered default {present_only, never} == toast_only's pair; `auto`
    // must win because it's checked first (the row IS at its default).
    expect(presetForEvent(null, "mail_delivered")).toBe("auto");
  });

  it("an exotic hand-edited pair that matches no preset reads as null (Custom)", () => {
    // absent_only toast + present_only push matches no preset.
    const policy: NotifyPolicy = {
      builder_archive: { toast: "absent_only", push: "present_only" },
    };
    expect(presetForEvent(policy, "builder_archive")).toBeNull();
  });
});

describe("presetMutatorArg — the exact updateSettings arg a preset click writes", () => {
  it("'Toast only' writes notifyPolicy with { toast: present_only, push: never }", () => {
    const arg = presetMutatorArg(null, "builder_archive", "toast_only");
    expect(arg).toEqual({
      notifyPolicy: { builder_archive: { toast: "present_only", push: "never" } },
    });
  });

  it("carries existing events forward and only re-writes the chosen one", () => {
    const prior: NotifyPolicy = {
      mail_delivered: { toast: "never", push: "never" },
    };
    const arg = presetMutatorArg(prior, "schedule_fired", "always_push");
    expect(arg).toEqual({
      notifyPolicy: {
        mail_delivered: { toast: "never", push: "never" },
        schedule_fired: { toast: "present_only", push: "always" },
      },
    });
  });
});

describe("dndMutatorArg — the exact updateSettings arg a DND input change writes", () => {
  it("a 'HH:MM' value sets the bound", () => {
    expect(dndMutatorArg("start", "22:30")).toEqual({ dndStart: "22:30" });
    expect(dndMutatorArg("end", "07:00")).toEqual({ dndEnd: "07:00" });
  });

  it("an empty input clears the bound to null (no DND on that side)", () => {
    expect(dndMutatorArg("start", "")).toEqual({ dndStart: null });
    expect(dndMutatorArg("end", "")).toEqual({ dndEnd: null });
  });
});

describe("criticalBypassMutatorArg — the exact updateSettings arg the toggle writes", () => {
  it("carries the boolean verbatim (true = critical alerts bypass DND)", () => {
    expect(criticalBypassMutatorArg(true)).toEqual({ criticalBypassDnd: true });
  });

  it("carries false (critical alerts respect DND)", () => {
    expect(criticalBypassMutatorArg(false)).toEqual({ criticalBypassDnd: false });
  });
});
