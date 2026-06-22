/**
 * FRI-171 / ADR-047 — The Intake classifier (DAEMON-ONLY).
 *
 * One stateless, single-turn call to the EXISTING Claude Agent SDK `query()`
 * (NOT the direct Messages API — no `@anthropic-ai/sdk` here). The call:
 *   - runs on the cheap model (`claude-haiku-4-5-20251001`), thinking disabled;
 *   - disables ALL built-in tools (`tools: []`) and the Task sub-agent;
 *   - caps at a single turn (`maxTurns: 1`) and registers NO MCP servers, NO
 *     hooks, NO resume/forkSession — every Capture is a fresh, isolated turn;
 *   - appends the code-owned {@link INTAKE_PERSONA_PROMPT} to the `claude_code`
 *     preset (safe for a single-turn call: the FRI-167 "frozen append on
 *     resume" gotcha is about RESUMED sessions; this one never resumes).
 *
 * The model is instructed (by the persona) to emit ONE JSON object matching the
 * `IntakeVerdict` shape; we collect the assistant text, JSON-parse it, and
 * zod-validate it. A parse/validate failure throws `IntakeClassifierError` —
 * the caller (intake.ts) degrades that to a Proposed item, NEVER dropping the
 * Capture.
 *
 * The SDK `query` import is the single mock seam: tests mock
 * `@anthropic-ai/claude-agent-sdk`'s `query` export to feed a canned verdict.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { IntakeVerdict } from "@friday/shared";
import { INTAKE_PERSONA_PROMPT } from "../prompts/intake-persona.js";
import { renderTargetGuidance, type RouteTarget } from "./registry.js";

type QueryOptions = NonNullable<Parameters<typeof query>[0]["options"]>;

/** The cheap model the classifier runs on. Full dated id (Haiku supports
 *  neither `effort` nor adaptive `max` — thinking stays disabled). */
export const INTAKE_MODEL = "claude-haiku-4-5-20251001";

/** Large autoCompactWindow so a single-turn classifier can never itself
 *  trigger compaction. */
const INTAKE_AUTO_COMPACT_WINDOW = 1_000_000;

/** Thrown when the classifier's output cannot be parsed/validated into an
 *  `IntakeVerdict`. The caller degrades to a Proposed item. */
export class IntakeClassifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeClassifierError";
  }
}

/** Zod shape for the raw verdict JSON the classifier emits. `targetId`/`payload`
 *  are nullable (null ⇒ Unsorted); `disposition` is the act/propose enum. */
const verdictSchema = z.object({
  cleaned: z.string(),
  targetId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  disposition: z.enum(["act", "propose"]),
  rationale: z.string(),
});

/**
 * Build the single-turn `query()` options for the classifier. PURE + exported
 * so a test can pin the load-bearing invariants (model, `tools: []`, `maxTurns:
 * 1`, the persona append, no resume/mcpServers) without running a query.
 *
 * @param abortController optional — wired by the caller's timeout so a stalled
 *   classifier can be torn down (the SDK's only abort lever is
 *   `options.abortController`).
 */
export function buildClassifierOptions(abortController?: AbortController): QueryOptions {
  return {
    model: INTAKE_MODEL,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // `[]` disables ALL built-in tools (Bash/Read/Write/Edit/Glob/Grep); the
    // classifier needs none — it only reasons over the Capture + target list.
    tools: [],
    disallowedTools: ["Task"],
    maxTurns: 1,
    settings: { autoMemoryEnabled: false, autoCompactWindow: INTAKE_AUTO_COMPACT_WINDOW },
    systemPrompt: { type: "preset", preset: "claude_code", append: INTAKE_PERSONA_PROMPT },
    ...(abortController ? { abortController } : {}),
  };
}

/** Concatenate the assistant `text` blocks from a single-turn query stream. */
async function collectAssistantText(
  q: AsyncIterable<unknown>,
  signal?: AbortSignal,
): Promise<string> {
  let text = "";
  for await (const fm of q) {
    if (signal?.aborted) break;
    const m = fm as { type?: string; message?: { content?: unknown } };
    if (m.type !== "assistant" || !Array.isArray(m.message?.content)) continue;
    for (const block of m.message.content) {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") text += b.text;
    }
  }
  return text;
}

/**
 * Extract the JSON object from the classifier's text. The persona instructs
 * "ONE JSON object and NOTHING else", but models occasionally wrap it in a
 * markdown fence or add a stray word; we tolerate that by slicing from the
 * first `{` to the last `}`. Throws `IntakeClassifierError` if no object-shaped
 * substring is present.
 */
export function extractVerdictJson(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new IntakeClassifierError(`classifier emitted no JSON object: ${raw.slice(0, 200)}`);
  }
  const slice = raw.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (e) {
    throw new IntakeClassifierError(
      `classifier emitted invalid JSON: ${(e as Error).message}: ${slice.slice(0, 200)}`,
    );
  }
}

/**
 * Parse + validate the classifier's text into an `IntakeVerdict`. Separated
 * from the SDK call so it can be unit-tested directly. Throws
 * `IntakeClassifierError` on any parse/validation failure.
 */
export function parseVerdict(rawText: string): IntakeVerdict {
  const obj = extractVerdictJson(rawText);
  const parsed = verdictSchema.safeParse(obj);
  if (!parsed.success) {
    throw new IntakeClassifierError(
      `classifier verdict failed validation: ${parsed.error.message}`,
    );
  }
  // `targetId`/`payload` widen to the IntakeVerdict union (RouteTargetId|null /
  // Record|null) — the daemon re-validates `payload` against the chosen
  // target's schema during gating; here we only enforce the envelope shape.
  return parsed.data as IntakeVerdict;
}

/**
 * Classify one Capture into an `IntakeVerdict`. Builds the prompt (raw Capture +
 * the rendered target guidance), runs the single-turn `query()`, collects the
 * assistant text, and parses/validates it. Throws `IntakeClassifierError` on
 * any failure — the caller degrades to Proposed.
 *
 * @param text     the raw Capture text.
 * @param targets  the assembled Route targets (their guidance is injected).
 * @param signal   optional abort signal (timeout) forwarded to the query.
 */
export async function classifyCapture(
  text: string,
  targets: RouteTarget[],
  signal?: AbortSignal,
): Promise<IntakeVerdict> {
  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }
  const prompt = `Capture:\n${text}\n\n${renderTargetGuidance(targets)}`;
  const q = query({ prompt, options: buildClassifierOptions(abortController) });
  const raw = await collectAssistantText(q as AsyncIterable<unknown>, signal);
  return parseVerdict(raw);
}
