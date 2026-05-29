/**
 * FRI-127 §3 / AC#5: the `mail_send` tool description must name the
 * return-path OBLIGATION before the priority-semantics paragraph. The prior
 * wording described the mechanism ("Send mail … for asynchronous
 * coordination") but never told a helper/builder that mailing the parent back
 * is required when a delegated task finishes — the loop's second failure mode.
 */

import { describe, expect, it } from "vitest";
import { MAIL_SEND_DESCRIPTION } from "./mail.js";

describe("mail_send description (FRI-127 §3)", () => {
  it("leads with the return-path obligation", () => {
    expect(MAIL_SEND_DESCRIPTION).toMatch(
      /^Send mail to another agent — including back to your parent\. REQUIRED when you finish a delegated task/,
    );
  });

  it("names the explicit final-action obligation", () => {
    expect(MAIL_SEND_DESCRIPTION).toContain("your final action must be mail_send");
  });

  it("states the obligation BEFORE the priority semantics", () => {
    expect(MAIL_SEND_DESCRIPTION.indexOf("REQUIRED")).toBeLessThan(
      MAIL_SEND_DESCRIPTION.indexOf("Priority semantics:"),
    );
  });

  it("preserves the priority semantics paragraph", () => {
    expect(MAIL_SEND_DESCRIPTION).toContain("`normal` (default)");
    expect(MAIL_SEND_DESCRIPTION).toContain("`critical`");
  });
});
