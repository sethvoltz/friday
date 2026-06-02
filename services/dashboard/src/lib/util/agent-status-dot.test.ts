/**
 * FRI-145 M5 — agent-status dot color (AC #8, AC #10).
 *
 * The `stalled` Status projection got its DAEMON producer restored in M5 (the
 * watchdog's `stall` Transition). This pins the DASHBOARD consumer: a `stalled`
 * agent paints the warn-colored dot (`--status-warn`). It also pins the M5
 * prune — there is no longer an `error` branch (a worker that exits mid-turn
 * self-heals to `idle`, so `error` resolves to the muted default, not a
 * dedicated `--status-error` dot).
 *
 * `agentStatusDot` is the single source of truth both the Sidebar and the
 * Command Palette import — testing it here covers both reviewer-corrected sites
 * (Sidebar.svelte:statusDot, CommandPalette.svelte:statusDotColor) as actual
 * behavior, not a source-text match.
 */

import { describe, expect, it } from "vitest";
import { agentStatusDot } from "./agent-status-dot";

describe("agentStatusDot (FRI-145 M5)", () => {
  it("stalled paints the warn-colored dot (--status-warn)", () => {
    // The load-bearing M5 assertion: the restored producer's projection has a
    // visible consumer.
    expect(agentStatusDot("stalled")).toBe("var(--status-warn)");
  });

  it("working paints the active dot (--status-ok)", () => {
    expect(agentStatusDot("working")).toBe("var(--status-ok)");
  });

  it("idle paints the muted dot (--text-tertiary)", () => {
    expect(agentStatusDot("idle")).toBe("var(--text-tertiary)");
  });

  it("archived paints the muted dot (--text-tertiary)", () => {
    expect(agentStatusDot("archived")).toBe("var(--text-tertiary)");
  });

  it("a pruned/unknown `error` status no longer has a dedicated dot — falls to muted", () => {
    // M5 pruned the agent-status `error`; there is no `--status-error` branch.
    expect(agentStatusDot("error")).toBe("var(--text-tertiary)");
    expect(agentStatusDot("error")).not.toBe("var(--status-error)");
  });

  it("undefined status falls to the muted default", () => {
    expect(agentStatusDot(undefined)).toBe("var(--text-tertiary)");
  });
});
