/**
 * FRI-95: pins the Part B.3 copy contract. Each (status, abortReason)
 * pair maps to a deterministic chat-visible string. If any of these
 * strings change, the test should fail loudly — the user has come to
 * rely on the exact wording (e.g. distinguishing "Stopped" from
 * "Stopped — worker had to be force-killed" is the only way they can
 * tell whether the worker cooperated or had to be SIGTERMed).
 */

import { describe, expect, it } from "vitest";
import { stopFooter } from "./stop-footer";

describe("stopFooter (FRI-95 Part B.3 copy contract)", () => {
  it("status='stopping' renders 'Stopping…' with the stopping class", () => {
    expect(stopFooter("stopping")).toEqual({
      text: "Stopping…",
      className: "stopping",
    });
  });

  it("status='aborted' with no abortReason renders 'Stopped' (cooperative-equivalent default)", () => {
    expect(stopFooter("aborted")).toEqual({ text: "Stopped" });
  });

  it("status='aborted' with abortReason='cooperative' renders 'Stopped'", () => {
    expect(stopFooter("aborted", "cooperative")).toEqual({ text: "Stopped" });
  });

  it("status='aborted' with abortReason='forced' renders the force-kill-specific copy", () => {
    expect(stopFooter("aborted", "forced")).toEqual({
      text: "Stopped — worker had to be force-killed",
    });
  });

  it("status='already_finished' renders 'Already finished'", () => {
    expect(stopFooter("already_finished")).toEqual({
      text: "Already finished",
    });
  });

  it("returns null for any other status — caller skips the footer", () => {
    // The non-stop statuses (complete, streaming, queued, error, …) have
    // their own affordances elsewhere; stopFooter is opt-in for the
    // Stop-specific lifecycle states only.
    expect(stopFooter("complete")).toBeNull();
    expect(stopFooter("complete", "forced")).toBeNull();
    expect(stopFooter("streaming")).toBeNull();
    expect(stopFooter("queued")).toBeNull();
    expect(stopFooter("error")).toBeNull();
    expect(stopFooter("running")).toBeNull();
    expect(stopFooter("done")).toBeNull();
    expect(stopFooter("")).toBeNull();
  });

  it("ignores abortReason when status isn't 'aborted' — defensive against stale fields on the message object", () => {
    expect(stopFooter("stopping", "forced")).toEqual({
      text: "Stopping…",
      className: "stopping",
    });
    expect(stopFooter("already_finished", "cooperative")).toEqual({
      text: "Already finished",
    });
  });
});
