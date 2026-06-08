import { describe, expect, it } from "vitest";
import { formatDelay } from "./schedule-wakeup-block";

describe("formatDelay", () => {
  it("formats sub-minute delays in seconds", () => {
    expect(formatDelay(0)).toBe("0s");
    expect(formatDelay(30)).toBe("30s");
    expect(formatDelay(59)).toBe("59s");
  });

  it("formats minute-range delays (rounded)", () => {
    expect(formatDelay(60)).toBe("1m");
    expect(formatDelay(90)).toBe("2m");
  });

  it("formats hour-range delays", () => {
    expect(formatDelay(3600)).toBe("1h 0m");
    expect(formatDelay(5400)).toBe("1h 30m");
    expect(formatDelay(7320)).toBe("2h 2m");
  });
});
