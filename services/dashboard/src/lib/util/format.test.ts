import { describe, expect, it } from "vitest";
import { fmtTokensCompact } from "./format.js";

describe("fmtTokensCompact (4 sig-fig collapse)", () => {
  it("returns plain integers below 1K", () => {
    expect(fmtTokensCompact(0)).toBe("0");
    expect(fmtTokensCompact(7)).toBe("7");
    expect(fmtTokensCompact(999)).toBe("999");
  });

  it("collapses thousands to K with 4 sig figs", () => {
    expect(fmtTokensCompact(1_000)).toBe("1.000K");
    expect(fmtTokensCompact(9_999)).toBe("9.999K");
    expect(fmtTokensCompact(12_340)).toBe("12.34K");
    expect(fmtTokensCompact(123_400)).toBe("123.4K");
  });

  it("collapses millions to M with 4 sig figs", () => {
    expect(fmtTokensCompact(1_000_000)).toBe("1.000M");
    expect(fmtTokensCompact(319_206_432)).toBe("319.2M");
  });

  it("collapses billions to B with 4 sig figs", () => {
    expect(fmtTokensCompact(4_213_000_000)).toBe("4.213B");
  });

  it("collapses trillions to T with 4 sig figs", () => {
    expect(fmtTokensCompact(1_500_000_000_000)).toBe("1.500T");
  });
});
