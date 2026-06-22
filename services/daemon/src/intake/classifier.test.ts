/**
 * FRI-171 / ADR-047 — Intake classifier: persona, options, verdict parsing.
 *
 * No SDK is exercised here — `buildClassifierOptions` is pure (the model id +
 * single-turn invariants are pinned without a query) and `parseVerdict` /
 * `extractVerdictJson` are pure parsers. AC11 (persona is code-owned, not the
 * ADR-005 stack) and AC12 (cheap model, thinking off) are asserted directly.
 */

import { describe, expect, it } from "vitest";
import { INTAKE_PERSONA_PROMPT } from "../prompts/intake-persona.js";
import {
  INTAKE_MODEL,
  IntakeClassifierError,
  buildClassifierOptions,
  extractVerdictJson,
  parseVerdict,
} from "./classifier.js";

describe("INTAKE_PERSONA_PROMPT (AC11)", () => {
  it("bakes the load-bearing intake directives", () => {
    const p = INTAKE_PERSONA_PROMPT;
    expect(p).toContain("Intake router");
    expect(p).toContain("CLEAN FAITHFULLY");
    expect(p).toContain("PRESERVE"); // meaning preserved during cleanup
    expect(p).toContain("CLASSIFY");
    expect(p).toContain("Unsorted"); // null-target fallback
    expect(p).toContain("act-vs-propose");
    expect(p).toContain("propose"); // Gate 2 disposition
    expect(p).toMatch(/ONE JSON object/i); // strict-JSON output contract
  });

  it("does NOT carry the ADR-005 SOUL / CONSTITUTION markers", () => {
    // The persona is code-owned and must NOT inherit the orchestrator's prompt
    // stack. Assert the markers `composeSystemPrompt`/`readPromptStack` emit are
    // absent (case-insensitive, to catch any rendered header form).
    expect(INTAKE_PERSONA_PROMPT).not.toMatch(/CONSTITUTION/i);
    expect(INTAKE_PERSONA_PROMPT).not.toMatch(/\bSOUL\b/i);
  });
});

describe("buildClassifierOptions (AC12)", () => {
  it("runs the cheap model with thinking off, single-turn, no tools", () => {
    const opts = buildClassifierOptions();
    expect(opts.model).toBe("claude-haiku-4-5-20251001");
    expect(INTAKE_MODEL).toBe("claude-haiku-4-5-20251001");
    expect(opts.maxTurns).toBe(1);
    expect(opts.tools).toEqual([]); // ALL built-ins off
    expect(opts.disallowedTools).toContain("Task");
    // No `thinking` knob is set (Haiku has none) — the option is absent.
    expect((opts as Record<string, unknown>).thinking).toBeUndefined();
    // The persona rides on the claude_code preset append; it never resumes.
    expect(opts.systemPrompt).toMatchObject({
      type: "preset",
      preset: "claude_code",
      append: INTAKE_PERSONA_PROMPT,
    });
    // Stateless: no resume / forkSession / mcpServers.
    expect((opts as Record<string, unknown>).resume).toBeUndefined();
    expect((opts as Record<string, unknown>).forkSession).toBeUndefined();
    expect((opts as Record<string, unknown>).mcpServers).toBeUndefined();
  });

  it("wires the abortController only when one is supplied", () => {
    expect((buildClassifierOptions() as Record<string, unknown>).abortController).toBeUndefined();
    const ac = new AbortController();
    expect(buildClassifierOptions(ac).abortController).toBe(ac);
  });
});

describe("extractVerdictJson + parseVerdict", () => {
  it("parses a clean JSON verdict into the IntakeVerdict shape", () => {
    const raw = JSON.stringify({
      cleaned: "thaw the chicken Thursday",
      targetId: "core:reminder",
      payload: { text: "thaw the chicken", dueDate: "2026-06-25" },
      disposition: "act",
      rationale: "time-anchored nudge",
    });
    const v = parseVerdict(raw);
    expect(v).toMatchObject({
      cleaned: "thaw the chicken Thursday",
      targetId: "core:reminder",
      payload: { text: "thaw the chicken", dueDate: "2026-06-25" },
      disposition: "act",
      rationale: "time-anchored nudge",
    });
  });

  it("tolerates a markdown fence / stray prose around the object", () => {
    const raw =
      'Here is the verdict:\n```json\n{"cleaned":"x","targetId":null,"payload":null,"disposition":"propose","rationale":"unsure"}\n```';
    const v = parseVerdict(raw);
    expect(v).toMatchObject({ targetId: null, payload: null, disposition: "propose" });
  });

  it("throws IntakeClassifierError when no JSON object is present", () => {
    expect(() => parseVerdict("I could not classify this.")).toThrow(IntakeClassifierError);
  });

  it("throws IntakeClassifierError on a structurally-invalid verdict", () => {
    // disposition is not in the enum.
    const raw = JSON.stringify({
      cleaned: "x",
      targetId: null,
      payload: null,
      disposition: "maybe",
      rationale: "r",
    });
    expect(() => parseVerdict(raw)).toThrow(IntakeClassifierError);
  });

  it("extractVerdictJson slices from the first { to the last }", () => {
    expect(extractVerdictJson('noise {"a":1} trailing')).toEqual({ a: 1 });
  });
});
