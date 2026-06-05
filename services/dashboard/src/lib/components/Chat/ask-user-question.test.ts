import { describe, expect, it } from "vitest";
import {
  OTHER_LABEL,
  buildAnswerPayload,
  isSubmissionReady,
  parseQuestions,
  parseToolResultOutput,
  selectionFromPayload,
  type AUQQuestion,
} from "./ask-user-question";

// FRI-152 — pure-`.ts` logic-seam coverage for the AskUserQuestion /
// `mcp__friday-elicitation__ask_user` renderer. Same node-pool / no-DOM
// convention as TodoWrite's `todo-render.test.ts`. The DOM-visual
// behaviors (radio/checkbox semantics, keyboard nav) are intentionally
// out of scope here.

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
});

describe("buildAnswerPayload — kind discriminator", () => {
  it("emits {kind: 'option'} when every pick is a listed option (single-select)", () => {
    const payload = buildAnswerPayload([Q_SIZE], {
      "Which size?": { selectedLabels: ["Small"], otherText: "", notes: "" },
    });
    expect(payload).toEqual({
      answers: {
        "Which size?": { kind: "option", value: "Small" },
      },
    });
  });

  it("emits {kind: 'option'} when every pick is listed (multi-select)", () => {
    const payload = buildAnswerPayload([Q_FLAVORS], {
      "Which flavors?": {
        selectedLabels: ["Vanilla", "Strawberry"],
        otherText: "",
        notes: "",
      },
    });
    expect(payload.answers["Which flavors?"]).toEqual({
      kind: "option",
      value: "Vanilla, Strawberry",
    });
  });

  it("emits {kind: 'other'} when the user typed in Other (single-select)", () => {
    const payload = buildAnswerPayload([Q_SIZE], {
      "Which size?": {
        selectedLabels: [OTHER_LABEL],
        otherText: "  Custom huge  ",
        notes: "",
      },
    });
    expect(payload.answers["Which size?"]).toEqual({
      kind: "other",
      value: "Custom huge",
    });
  });

  it("emits {kind: 'other'} when Other text mixes with a listed label (multi-select)", () => {
    const payload = buildAnswerPayload([Q_FLAVORS], {
      "Which flavors?": {
        selectedLabels: ["Vanilla", OTHER_LABEL],
        otherText: "Mango",
        notes: "",
      },
    });
    expect(payload.answers["Which flavors?"]).toEqual({
      kind: "other",
      value: "Vanilla, Mango",
    });
  });

  it("drops Other-with-no-text and falls back to kind: 'option'", () => {
    const payload = buildAnswerPayload([Q_FLAVORS], {
      "Which flavors?": {
        selectedLabels: ["Vanilla", OTHER_LABEL],
        otherText: "   ",
        notes: "",
      },
    });
    // Other-with-empty-text drops; only the listed label remains and the
    // discriminator flips back to 'option'.
    expect(payload.answers["Which flavors?"]).toEqual({
      kind: "option",
      value: "Vanilla",
    });
  });
});

describe("buildAnswerPayload — annotations", () => {
  it("omits annotations field entirely when no question carries notes", () => {
    const payload = buildAnswerPayload([Q_SIZE], {
      "Which size?": { selectedLabels: ["Small"], otherText: "", notes: "   " },
    });
    expect(payload.annotations).toBeUndefined();
  });

  it("adds trimmed notes for the matching question only", () => {
    const payload = buildAnswerPayload([Q_SIZE, Q_FLAVORS], {
      "Which size?": {
        selectedLabels: ["Small"],
        otherText: "",
        notes: "  because portability matters  ",
      },
      "Which flavors?": {
        selectedLabels: ["Vanilla"],
        otherText: "",
        notes: "",
      },
    });
    expect(payload.annotations).toEqual({
      "Which size?": { notes: "because portability matters" },
    });
  });
});

describe("isSubmissionReady", () => {
  it("returns false when not every question has a selection", () => {
    const ready = isSubmissionReady([Q_SIZE, Q_FLAVORS], {
      "Which size?": { selectedLabels: ["Small"], otherText: "", notes: "" },
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

describe("parseToolResultOutput", () => {
  it("returns null for empty / undefined output", () => {
    expect(parseToolResultOutput(undefined)).toBeNull();
    expect(parseToolResultOutput("")).toBeNull();
  });

  it("returns null for an output that isn't JSON or lacks an answers field", () => {
    expect(parseToolResultOutput("Error: tool denied")).toBeNull();
    expect(parseToolResultOutput(JSON.stringify({ questions: [] }))).toBeNull();
  });

  it("parses the canonical MCP echo shape into an AUQAnswerPayload", () => {
    const echo = {
      questions: [Q_SIZE],
      answers: { "Which size?": { kind: "option", value: "Small" } },
      annotations: { "Which size?": { notes: "for travel" } },
    };
    const parsed = parseToolResultOutput(JSON.stringify(echo));
    expect(parsed).toEqual({
      answers: { "Which size?": { kind: "option", value: "Small" } },
      annotations: { "Which size?": { notes: "for travel" } },
    });
  });

  it("rejects an answers shape that doesn't carry the {kind, value} discriminator", () => {
    // Pre-reshape (flat string) payload — must not pass the new validator.
    expect(parseToolResultOutput(JSON.stringify({ answers: { Q: "A" } }))).toBeNull();
    // Invalid kind value.
    expect(
      parseToolResultOutput(JSON.stringify({ answers: { Q: { kind: "freeform", value: "A" } } })),
    ).toBeNull();
  });
});

describe("selectionFromPayload (lock-state rehydration)", () => {
  it("rehydrates single-select selection from a stored option payload", () => {
    const selection = selectionFromPayload([Q_SIZE], {
      answers: { "Which size?": { kind: "option", value: "Small" } },
    });
    expect(selection).toEqual({
      "Which size?": { selectedLabels: ["Small"], otherText: "", notes: "" },
    });
  });

  it("rehydrates multi-select selection from comma-joined string", () => {
    const selection = selectionFromPayload([Q_FLAVORS], {
      answers: { "Which flavors?": { kind: "option", value: "Vanilla, Strawberry" } },
    });
    expect(selection["Which flavors?"]!.selectedLabels).toEqual(["Vanilla", "Strawberry"]);
  });

  it("classifies an unknown answer string as Other with the literal text", () => {
    const selection = selectionFromPayload([Q_SIZE], {
      answers: { "Which size?": { kind: "other", value: "Custom huge" } },
    });
    expect(selection["Which size?"]!.selectedLabels).toEqual([OTHER_LABEL]);
    expect(selection["Which size?"]!.otherText).toBe("Custom huge");
  });

  it("rehydrates notes onto the matching question", () => {
    const selection = selectionFromPayload([Q_SIZE], {
      answers: { "Which size?": { kind: "option", value: "Small" } },
      annotations: { "Which size?": { notes: "for travel" } },
    });
    expect(selection["Which size?"]!.notes).toBe("for travel");
  });
});
