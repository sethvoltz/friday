import { describe, it, expect } from "vitest";
import { shouldShowToggle } from "./collapsible-toggle";

// FRI-137 AC5 (pure derivation): the disclosure toggle + clamp appear ONLY
// when measured content height exceeds the collapsed cap. The DOM
// scrollHeight read and the rendered visual cases are pinned in Playwright;
// this pins the comparison the component reduces to.
describe("shouldShowToggle", () => {
  const CAP = 400;

  it("fits within the cap → no toggle", () => {
    expect(shouldShowToggle(120, CAP)).toBe(false);
    expect(shouldShowToggle(399, CAP)).toBe(false);
  });

  it("exactly equal to the cap → no toggle (fits, nothing hidden)", () => {
    expect(shouldShowToggle(400, CAP)).toBe(false);
  });

  it("overflows the cap → show toggle", () => {
    expect(shouldShowToggle(401, CAP)).toBe(true);
    expect(shouldShowToggle(2000, CAP)).toBe(true);
  });

  it("pre-measure (height 0) reads as fits → no toggle, so it never flashes on", () => {
    expect(shouldShowToggle(0, CAP)).toBe(false);
  });

  it("is independent of the open state — scrollHeight already captures full height", () => {
    // A fitting section never shows a toggle even when expanded (startOpen),
    // and an overflowing one always shows one regardless of open/closed.
    expect(shouldShowToggle(120, CAP, true)).toBe(false);
    expect(shouldShowToggle(120, CAP, false)).toBe(false);
    expect(shouldShowToggle(900, CAP, true)).toBe(true);
    expect(shouldShowToggle(900, CAP, false)).toBe(true);
  });

  it("respects different caps (todo 320, mail 200, toolblock 300)", () => {
    expect(shouldShowToggle(250, 320)).toBe(false);
    expect(shouldShowToggle(321, 320)).toBe(true);
    expect(shouldShowToggle(150, 200)).toBe(false);
    expect(shouldShowToggle(201, 200)).toBe(true);
    expect(shouldShowToggle(280, 300)).toBe(false);
    expect(shouldShowToggle(301, 300)).toBe(true);
  });
});
