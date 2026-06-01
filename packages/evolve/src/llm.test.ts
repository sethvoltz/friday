/**
 * FRI-64: `extractJson` regression corpus.
 *
 * Pins the known failure modes the parser must handle. Each test name
 * matches its load-bearing assertion; assertions pin specific parsed
 * values or specific error substrings rather than type-only checks.
 *
 * Day-22 root cause: the previous non-greedy fence regex
 * (`/```(?:json)?\s*([\s\S]*?)```/`) truncated whenever the body
 * field contained markdown code fences (Suggested-change sections
 * often emit them). The current implementation does a string- and
 * escape-aware bracket-balanced walk over the raw text; case
 * "fenced JSON whose body contains inner triple backticks" is the
 * specific day-22 regression pin.
 */

import { describe, expect, it } from "vitest";
import { extractJson } from "./llm.js";

interface EnrichShape {
  body: string;
  type: "memory" | "prompt" | "config" | "code";
  blastRadius: "low" | "medium" | "high";
}

describe("extractJson", () => {
  it("parses plain JSON with no surrounding prose or fences", () => {
    const input = '{"body":"plain ok","type":"prompt","blastRadius":"low"}';
    const parsed = extractJson<EnrichShape>(input);
    expect(parsed.body).toBe("plain ok");
    expect(parsed.type).toBe("prompt");
    expect(parsed.blastRadius).toBe("low");
  });

  it("parses JSON wrapped in a ```json fenced block", () => {
    const input = '```json\n{"body":"fenced ok","type":"code","blastRadius":"medium"}\n```';
    const parsed = extractJson<EnrichShape>(input);
    expect(parsed.body).toBe("fenced ok");
    expect(parsed.type).toBe("code");
    expect(parsed.blastRadius).toBe("medium");
  });

  it("parses JSON wrapped in a bare ``` fenced block (no language tag)", () => {
    const input = '```\n{"body":"bare fence","type":"memory","blastRadius":"low"}\n```';
    const parsed = extractJson<EnrichShape>(input);
    expect(parsed.body).toBe("bare fence");
    expect(parsed.type).toBe("memory");
  });

  it("parses fenced JSON whose body contains inner triple backticks (FRI-64 day-22 regression)", () => {
    // The body field is markdown that itself includes a code-fenced
    // example. The previous non-greedy fence regex closed on the
    // INNER ``` and truncated the JSON.
    const innerBody = [
      "## Suggested change",
      "Add this to orchestrator.md:",
      "",
      "```",
      "When the user's message contains a direct action imperative...",
      "```",
      "",
      "This pins the behavior.",
    ].join("\n");
    const json = JSON.stringify({
      body: innerBody,
      type: "prompt",
      blastRadius: "low",
    });
    const input = "```json\n" + json + "\n```";

    const parsed = extractJson<EnrichShape>(input);
    expect(parsed.body).toBe(innerBody);
    expect(parsed.body).toContain("```");
    expect(parsed.body).toContain("direct action imperative");
    expect(parsed.type).toBe("prompt");
    expect(parsed.blastRadius).toBe("low");
  });

  it("parses JSON with leading and trailing prose around the object", () => {
    const input =
      'Here you go:\n\n{"body":"prose wrapped","type":"prompt","blastRadius":"low"}\n\nLet me know.';
    const parsed = extractJson<EnrichShape>(input);
    expect(parsed.body).toBe("prose wrapped");
    expect(parsed.type).toBe("prompt");
  });

  it("parses JSON whose body quotes the user with escaped double quotes (FRI-64 hrw2 input)", () => {
    // The exact day-22 hrw2 quoted user-speech shape. The body
    // contains `\"Nah just go straight into building everything\"`
    // as a properly escaped JSON string. Verify the parsed body
    // round-trips to the literal quoted phrase.
    const literalBody =
      'User said: "Nah just go straight into building everything" — direct imperative.';
    const json = JSON.stringify({
      body: literalBody,
      type: "prompt",
      blastRadius: "low",
    });
    const input = "```json\n" + json + "\n```";

    const parsed = extractJson<EnrichShape>(input);
    expect(parsed.body).toBe(literalBody);
    expect(parsed.body).toContain('"Nah just go straight into building everything"');
  });

  it("parses JSON containing a literal backslash followed by an escaped quote in a string", () => {
    // Raw JSON source has `\\\"` (three chars) which parses to `\"`
    // (two chars: backslash + literal quote). Bracket-balance must
    // treat the first `\\` as escape-then-escaped-char (so escape
    // resets), and the `\"` as a properly escaped quote inside the
    // string — NOT close the string after `\\`.
    const input = '{"body":"path\\\\\\"x","type":"prompt","blastRadius":"low"}';
    const parsed = extractJson<EnrichShape>(input);
    expect(parsed.body).toBe('path\\"x');
  });

  it("parses JSON whose string field contains a stray `}` character", () => {
    // A `}` inside a JSON string must NOT close the object. The
    // bracket-balance walker treats it as ordinary in-string content.
    const input = '{"body":"function () { return 1; }","type":"code","blastRadius":"medium"}';
    const parsed = extractJson<EnrichShape>(input);
    expect(parsed.body).toBe("function () { return 1; }");
    expect(parsed.type).toBe("code");
  });

  it("throws 'No JSON object found' when the input has no `{` character", () => {
    expect(() => extractJson("just prose, no braces here")).toThrowError(/No JSON object found/);
  });

  it("throws 'Failed to parse JSON' when braces balance but the inner JSON is malformed", () => {
    // Braces close at depth 0 — but the slice is invalid JSON
    // (missing colon between key and value). Must surface as a parse
    // error, NOT silently return a partial / falsy value.
    const input = '{"foo" "bar"}';
    expect(() => extractJson(input)).toThrowError(/Failed to parse JSON/);
  });

  it("throws 'Unterminated JSON object' when the closing `}` is missing", () => {
    const input = '{"body": "no closing brace';
    expect(() => extractJson(input)).toThrowError(/Unterminated JSON object/);
  });

  it("includes a ±40-char failure snippet in the parse-error message", () => {
    // When braces balance but the inner JSON is malformed, the thrown error
    // must include both the raw text AND a snippet windowed on the parse
    // position. Future failures triage from the snippet alone instead of
    // needing to scroll the full Raw: dump.
    const pad = "x".repeat(60);
    const input = `{"key":"${pad}",MALFORMED_HERE"key2":"v"}`;
    try {
      extractJson(input);
      throw new Error("extractJson should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/Failed to parse JSON/);
      expect(msg).toMatch(/Failure snippet/);
      // The window must reference the actual offending region.
      expect(msg).toContain("MALFORMED_HERE");
    }
  });
});
