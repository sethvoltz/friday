import { describe, it, expect } from "vitest";
import { maybePrintVersion } from "./version.js";

describe("maybePrintVersion", () => {
  it("writes the bare version with no [log] prefix and returns true for --version", () => {
    let out = "";
    const handled = maybePrintVersion(["--version"], "1.2.3", (s) => {
      out += s;
    });
    expect(handled).toBe(true);
    expect(out).toBe("1.2.3\n");
  });

  it("handles the -v alias identically", () => {
    let out = "";
    const handled = maybePrintVersion(["-v"], "1.2.3", (s) => {
      out += s;
    });
    expect(handled).toBe(true);
    expect(out).toBe("1.2.3\n");
  });

  it("defers to citty (returns false, writes nothing) when --version is not the sole arg", () => {
    let out = "";
    const write = (s: string) => {
      out += s;
    };
    expect(maybePrintVersion(["status", "--version"], "1.2.3", write)).toBe(false);
    expect(maybePrintVersion([], "1.2.3", write)).toBe(false);
    expect(maybePrintVersion(["--help"], "1.2.3", write)).toBe(false);
    expect(out).toBe("");
  });
});
