import { describe, expect, it } from "vitest";
import { MEMORY_SAVE_DESCRIPTION, validateMemoryField } from "./memory.js";

describe("validateMemoryField", () => {
  it("accepts a normal memory body", () => {
    expect(
      validateMemoryField("content", "User prefers pnpm over npm in this monorepo."),
    ).toBeNull();
  });

  it("accepts content that legitimately contains an XML-like phrase mid-body", () => {
    // Possible in a memory about parsing or HTML; only TRAILING parameter
    // tokens should trip the validator.
    expect(
      validateMemoryField(
        "content",
        "Reminder: the dashboard renders `</details>` close tags inside code fences without issue.",
      ),
    ).toBeNull();
  });

  it("rejects content ending with </content>", () => {
    const reason = validateMemoryField("content", "User prefers pnpm.</content>");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/parameter-closing token/i);
  });

  it("rejects content ending with </tags>", () => {
    const reason = validateMemoryField("content", 'Some body.\n<tags>["user", "tooling"]</tags>');
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/parameter-closing token/i);
  });

  it("rejects content ending with </content> even with trailing whitespace/newlines", () => {
    const reason = validateMemoryField("content", "Body text.</content>\n\n  \t  ");
    expect(reason).not.toBeNull();
  });

  it("rejects content containing </invoke> anywhere — the exact bug Friday reported", () => {
    const reason = validateMemoryField(
      "content",
      'User prefers pnpm over npm. The project defaults to npm.</content>\n<tags>["user", "tooling", "pnpm"]</tags>\n</invoke>',
    );
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/<\/invoke>/);
  });

  it("rejects </invoke> mid-string, not just trailing", () => {
    const reason = validateMemoryField("content", "Body part one.</invoke> Body part two.");
    expect(reason).not.toBeNull();
  });

  it("names the field in the rejection so the caller knows which parameter is bad", () => {
    const reason = validateMemoryField("patch.title", "Bad title.</title>");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/^patch\.title /);
  });
});

describe("MEMORY_SAVE_DESCRIPTION (FRI-141 doc/tool lockstep)", () => {
  // The memory_save tool description and protocols/memory.md must stay in
  // lockstep on the memory type enumeration. Pin every type tag so a silent
  // drop of one (e.g. `person`) from the description fails here instead of
  // shipping. The protocol doc is golden-snapshotted separately.
  it("enumerates all five memory type tags including person", () => {
    for (const type of ["user", "feedback", "project", "reference", "person"]) {
      expect(MEMORY_SAVE_DESCRIPTION).toContain(`\`${type}\``);
    }
  });
});
