import { describe, expect, it } from "vitest";
import {
  AUQ_MARKER,
  OTHER_LABEL,
  buildAnswerPayload,
  formatAnswerMessageBody,
  formatHumanReadableAnswer,
  isSubmissionReady,
  parseAnswerMessageBody,
  parseQuestions,
  selectionFromPayload,
  type AUQQuestion,
} from "./ask-user-question";

// FRI-152 — pure-`.ts` logic-seam coverage for the AskUserQuestion
// renderer. Same node-pool / no-DOM convention as TodoWrite's
// `todo-render.test.ts`. The DOM-visual behaviors (radio/checkbox
// semantics, keyboard nav) are intentionally out of scope here.

const Q_SIZE: AUQQuestion = {
  question: "Which size?",
  header: "Size",
  multiSelect: false,
  options: [
    { label: "Small", description: "Fits in your hand." },
    { label: "Large", description: "Takes both hands.", preview: "preview text" },
  ],
};
const Q_FLAVORS: AUQQuestion = {
  question: "Which flavors?",
  header: "Flavors",
  multiSelect: true,
  options: [
    { label: "Vanilla", description: "Classic." },
    { label: "Chocolate", description: "Rich." },
    { label: "Strawberry", description: "Fruity." },
  ],
};

describe("parseQuestions", () => {
  it("returns [] for non-object / null / missing-questions inputs", () => {
    expect(parseQuestions(undefined)).toEqual([]);
    expect(parseQuestions(null)).toEqual([]);
    expect(parseQuestions(42)).toEqual([]);
    expect(parseQuestions({})).toEqual([]);
    expect(parseQuestions({ questions: "nope" })).toEqual([]);
  });

  it("parses a valid single-select question with preview", () => {
    const parsed = parseQuestions({
      questions: [
        {
          question: "Which size?",
          header: "Size",
          multiSelect: false,
          options: [
            { label: "S", description: "small" },
            { label: "L", description: "large", preview: "🦣" },
          ],
        },
      ],
    });
    expect(parsed.length).toBe(1);
    expect(parsed[0]).toMatchObject({
      question: "Which size?",
      header: "Size",
      multiSelect: false,
    });
    expect(parsed[0]!.options).toEqual([
      { label: "S", description: "small" },
      { label: "L", description: "large", preview: "🦣" },
    ]);
  });

  it("defaults multiSelect to false when not strictly true", () => {
    const parsed = parseQuestions({
      questions: [
        {
          question: "Q?",
          header: "Q",
          // truthy but not literal true
          multiSelect: "yes",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
      ],
    });
    expect(parsed[0]!.multiSelect).toBe(false);
  });

  it("skips questions with no valid options and skips malformed options", () => {
    const parsed = parseQuestions({
      questions: [
        {
          question: "Skipped",
          header: "X",
          multiSelect: false,
          options: [{ description: "no label" }, "not-an-object"],
        },
        {
          question: "Kept",
          header: "K",
          multiSelect: false,
          options: [{ label: "A", description: "a" }, null, { label: "B", description: "b" }],
        },
      ],
    });
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.question).toBe("Kept");
    expect(parsed[0]!.options.map((o) => o.label)).toEqual(["A", "B"]);
  });

  it("does not enforce SDK count limits (renders bad input rather than empty panel)", () => {
    const parsed = parseQuestions({
      questions: [
        {
          question: "Q?",
          header: "Q",
          multiSelect: false,
          // 5 options — over the SDK's 4-option cap. We still render them.
          options: Array.from({ length: 5 }, (_, i) => ({
            label: `Opt${i}`,
            description: "",
          })),
        },
      ],
    });
    expect(parsed[0]!.options.length).toBe(5);
  });
});

describe("buildAnswerPayload — single-select", () => {
  it("emits answers[Q] equal to the single chosen label", () => {
    const payload = buildAnswerPayload("tool_abc", [Q_SIZE], {
      "Which size?": { selectedLabels: ["Small"], otherText: "", notes: "" },
    });
    expect(payload).toEqual({
      toolUseId: "tool_abc",
      answers: { "Which size?": "Small" },
    });
  });

  it("omits annotations field entirely when no question carries notes", () => {
    const payload = buildAnswerPayload("tool_abc", [Q_SIZE], {
      "Which size?": { selectedLabels: ["Small"], otherText: "", notes: "   " },
    });
    expect(payload.annotations).toBeUndefined();
  });

  it("adds annotations when notes are non-empty (trimmed)", () => {
    const payload = buildAnswerPayload("tool_abc", [Q_SIZE], {
      "Which size?": {
        selectedLabels: ["Small"],
        otherText: "",
        notes: "  because portability matters  ",
      },
    });
    expect(payload.annotations).toEqual({
      "Which size?": { notes: "because portability matters" },
    });
  });
});

describe("buildAnswerPayload — multi-select", () => {
  it("joins multi-select labels with comma+space in chosen order", () => {
    const payload = buildAnswerPayload("tool_xyz", [Q_FLAVORS], {
      "Which flavors?": {
        selectedLabels: ["Vanilla", "Strawberry"],
        otherText: "",
        notes: "",
      },
    });
    expect(payload.answers["Which flavors?"]).toBe("Vanilla, Strawberry");
  });

  it("preserves the user's selection order, not the option list order", () => {
    const payload = buildAnswerPayload("tool_xyz", [Q_FLAVORS], {
      "Which flavors?": {
        selectedLabels: ["Chocolate", "Vanilla"],
        otherText: "",
        notes: "",
      },
    });
    expect(payload.answers["Which flavors?"]).toBe("Chocolate, Vanilla");
  });
});

describe("buildAnswerPayload — Other path", () => {
  it("substitutes the user-typed text for the Other label (single-select)", () => {
    const payload = buildAnswerPayload("tool_abc", [Q_SIZE], {
      "Which size?": {
        selectedLabels: [OTHER_LABEL],
        otherText: "  Custom huge  ",
        notes: "",
      },
    });
    expect(payload.answers["Which size?"]).toBe("Custom huge");
  });

  it("joins Other text alongside listed labels in multi-select", () => {
    const payload = buildAnswerPayload("tool_xyz", [Q_FLAVORS], {
      "Which flavors?": {
        selectedLabels: ["Vanilla", OTHER_LABEL],
        otherText: "Mango",
        notes: "",
      },
    });
    expect(payload.answers["Which flavors?"]).toBe("Vanilla, Mango");
  });

  it("omits Other from the joined string when otherText is empty (no quiet 'Other' literal)", () => {
    const payload = buildAnswerPayload("tool_xyz", [Q_FLAVORS], {
      "Which flavors?": {
        selectedLabels: ["Vanilla", OTHER_LABEL],
        otherText: "   ",
        notes: "",
      },
    });
    // Other-with-no-text drops; only the listed label remains.
    expect(payload.answers["Which flavors?"]).toBe("Vanilla");
  });
});

describe("isSubmissionReady", () => {
  it("returns false when not every question has a selection", () => {
    const ready = isSubmissionReady([Q_SIZE, Q_FLAVORS], {
      "Which size?": { selectedLabels: ["Small"], otherText: "", notes: "" },
      // Q_FLAVORS missing
    });
    expect(ready).toBe(false);
  });

  it("returns false when Other is the only pick and the text is empty", () => {
    const ready = isSubmissionReady([Q_SIZE], {
      "Which size?": { selectedLabels: [OTHER_LABEL], otherText: "  ", notes: "" },
    });
    expect(ready).toBe(false);
  });

  it("returns true when every question has at least one valid selection", () => {
    const ready = isSubmissionReady([Q_SIZE, Q_FLAVORS], {
      "Which size?": { selectedLabels: ["Small"], otherText: "", notes: "" },
      "Which flavors?": {
        selectedLabels: ["Vanilla", "Chocolate"],
        otherText: "",
        notes: "",
      },
    });
    expect(ready).toBe(true);
  });

  it("returns false on an empty questions list", () => {
    expect(isSubmissionReady([], {})).toBe(false);
  });
});

describe("formatHumanReadableAnswer", () => {
  it("renders one bullet per question using the chip header", () => {
    const text = formatHumanReadableAnswer([Q_SIZE, Q_FLAVORS], {
      toolUseId: "x",
      answers: {
        "Which size?": "Small",
        "Which flavors?": "Vanilla, Chocolate",
      },
    });
    expect(text).toBe("- Size: Small\n- Flavors: Vanilla, Chocolate");
  });

  it("appends notes inline when present", () => {
    const text = formatHumanReadableAnswer([Q_SIZE], {
      toolUseId: "x",
      answers: { "Which size?": "Small" },
      annotations: { "Which size?": { notes: "for travel" } },
    });
    expect(text).toBe("- Size: Small — note: for travel");
  });
});

describe("formatAnswerMessageBody / parseAnswerMessageBody — roundtrip", () => {
  it("round-trips a payload through encode + decode byte-equal", () => {
    const payload = {
      toolUseId: "toolu_01abc",
      answers: { "Which size?": "Small", "Which flavors?": "Vanilla, Chocolate" },
      annotations: { "Which size?": { notes: "for travel" } },
    } as const;
    const body = formatAnswerMessageBody([Q_SIZE, Q_FLAVORS], { ...payload });
    expect(body.startsWith("- Size: Small")).toBe(true);
    expect(body).toContain(AUQ_MARKER);
    const parsed = parseAnswerMessageBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.payload).toEqual(payload);
  });

  it("strips the marker AND its leading blank line from displayText", () => {
    const body = formatAnswerMessageBody([Q_SIZE], {
      toolUseId: "t",
      answers: { "Which size?": "Small" },
    });
    const parsed = parseAnswerMessageBody(body);
    expect(parsed!.displayText).toBe("- Size: Small");
    expect(parsed!.displayText.endsWith("\n")).toBe(false);
  });

  it("returns null for a text without the marker (idempotent on plain user input)", () => {
    expect(parseAnswerMessageBody("hello there")).toBeNull();
    expect(parseAnswerMessageBody("")).toBeNull();
  });

  it("returns null for a malformed base64 payload (no throw)", () => {
    expect(parseAnswerMessageBody(`prefix\n\n${AUQ_MARKER}not-base64!@#`)).toBeNull();
  });

  it("returns null for a payload whose JSON shape is wrong (no toolUseId)", () => {
    const garbage = Buffer.from(JSON.stringify({ answers: {} }), "utf8").toString("base64");
    expect(parseAnswerMessageBody(`prefix\n\n${AUQ_MARKER}${garbage}`)).toBeNull();
  });

  it("survives a literal AUQ_MARKER string inside a notes field (defense by base64)", () => {
    const payload = {
      toolUseId: "toolu_01abc",
      answers: { "Which size?": "Small" },
      annotations: { "Which size?": { notes: `evil ${AUQ_MARKER} payload` } },
    } as const;
    const body = formatAnswerMessageBody([Q_SIZE], { ...payload });
    // lastIndexOf strategy + base64 encoding means the literal marker
    // inside notes can't defeat the parser.
    const parsed = parseAnswerMessageBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.payload).toEqual(payload);
  });
});

describe("selectionFromPayload", () => {
  it("rehydrates single-select selection from a stored payload", () => {
    const selection = selectionFromPayload([Q_SIZE], {
      toolUseId: "x",
      answers: { "Which size?": "Small" },
    });
    expect(selection).toEqual({
      "Which size?": { selectedLabels: ["Small"], otherText: "", notes: "" },
    });
  });

  it("rehydrates multi-select selection from comma-joined string", () => {
    const selection = selectionFromPayload([Q_FLAVORS], {
      toolUseId: "x",
      answers: { "Which flavors?": "Vanilla, Strawberry" },
    });
    expect(selection["Which flavors?"]!.selectedLabels).toEqual(["Vanilla", "Strawberry"]);
  });

  it("classifies an unknown answer string as Other with the literal text", () => {
    const selection = selectionFromPayload([Q_SIZE], {
      toolUseId: "x",
      answers: { "Which size?": "Custom huge" },
    });
    expect(selection["Which size?"]!.selectedLabels).toEqual([OTHER_LABEL]);
    expect(selection["Which size?"]!.otherText).toBe("Custom huge");
  });

  it("rehydrates notes onto the matching question", () => {
    const selection = selectionFromPayload([Q_SIZE], {
      toolUseId: "x",
      answers: { "Which size?": "Small" },
      annotations: { "Which size?": { notes: "for travel" } },
    });
    expect(selection["Which size?"]!.notes).toBe("for travel");
  });
});
