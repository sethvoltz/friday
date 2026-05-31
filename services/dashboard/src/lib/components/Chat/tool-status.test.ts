import { describe, it, expect } from "vitest";
import { badgeClass, statusLabel } from "./tool-status";

// FRI-137 AC3 (pure mapping): the file-edit header's status indicator reuses
// the same status → `.badge` modifier + text mapping ToolBlock/MailToolBlock
// use. The rendered badge is pinned in Playwright; this pins the derivation.
describe("badgeClass", () => {
  it("maps each tool status to its globally-styled .badge modifier", () => {
    expect(badgeClass("done")).toBe("ok");
    expect(badgeClass("error")).toBe("error");
    expect(badgeClass("aborted")).toBe("muted");
    expect(badgeClass("running")).toBe("warn");
  });

  it("falls back to warn for an unknown status", () => {
    expect(badgeClass("weird")).toBe("warn");
  });
});

describe("statusLabel", () => {
  it("maps each tool status to its human-readable badge text", () => {
    expect(statusLabel("running")).toBe("running…");
    expect(statusLabel("done")).toBe("done");
    expect(statusLabel("aborted")).toBe("stopped");
  });

  it("renders error and any unknown status verbatim", () => {
    expect(statusLabel("error")).toBe("error");
    expect(statusLabel("weird")).toBe("weird");
  });
});
