import { describe, it, expect } from "vitest";
import { computeVisibleCount, type VisibleCountInput } from "./header-nav";

// Real-ish header geometry: Chat word ~40px, Dashboard word ~80px, More
// hamburger ~28px, Inbox bell 32px (2rem, constant — badge is absolute), ⌘K
// chip ~36px. Matches +layout.svelte's NAV_GAP=4 / CLUSTER_GAP=12.
const BASE: VisibleCountInput = {
  availWidth: 0,
  linkWidths: [40, 80],
  navCount: 2,
  moreWidth: 28,
  navGap: 4,
  clusterGap: 12,
  clusterReserves: [],
};

describe("computeVisibleCount — priority+ header overflow", () => {
  it("REGRESSION: reserving the Inbox bell flips a link from visible into More at the same width", () => {
    // At 130px both links (40 + 4 + 80 = 124) fit with NO cluster items.
    expect(computeVisibleCount({ ...BASE, availWidth: 130 })).toBe(2);
    // Add the 32px bell: budget = 130 - (32+12) = 86 < 124, so a More button is
    // forced and only Chat fits to its left → exactly 1 (which renders as the
    // icon). Pre-fix this returned 2 and Dashboard overflowed/clipped.
    expect(computeVisibleCount({ ...BASE, availWidth: 130, clusterReserves: [32] })).toBe(1);
  });

  it("shows all links when the header is wide, even with bell + ⌘K reserved", () => {
    expect(computeVisibleCount({ ...BASE, availWidth: 400, clusterReserves: [32, 36] })).toBe(2);
  });

  it("collapses to a single (icon) link at a narrow width with the bell present", () => {
    // 124px avail, bell only: budget = 124 - 44 = 80; Chat(40)+More(40) = 80 fits,
    // Dashboard does not → 1.
    expect(computeVisibleCount({ ...BASE, availWidth: 124, clusterReserves: [32] })).toBe(1);
  });

  it("skips zero-width (hidden/unmeasured) cluster reserves — no phantom gap cost", () => {
    // A hidden ⌘K (0) must cost nothing: [32,0] behaves exactly like [32].
    expect(computeVisibleCount({ ...BASE, availWidth: 174, clusterReserves: [32, 0] })).toBe(2);
    // A real 12px second item DOES subtract (12+gap), flipping the same width.
    expect(computeVisibleCount({ ...BASE, availWidth: 174, clusterReserves: [32, 12] })).toBe(1);
  });

  it("bails to all-visible before measurement (avail 0 or width count mismatch)", () => {
    expect(computeVisibleCount({ ...BASE, availWidth: 0, clusterReserves: [32] })).toBe(2);
    expect(
      computeVisibleCount({ ...BASE, availWidth: 130, linkWidths: [40], clusterReserves: [32] }),
    ).toBe(2);
  });
});
