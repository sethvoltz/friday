/**
 * Pure logic seam for the AskUserQuestion / MCP `ask_user` renderer
 * (FRI-152).
 *
 * Everything in here is ts-only — no Svelte, no DOM. The companion
 * `AskUserQuestionPanel.svelte` calls these for input parsing, payload
 * shaping, and locked-state rehydration. Keeping the logic out of the
 * component lets the node-pool vitest suite pin behavior with full
 * coverage without standing up a DOM harness (same pattern todo-render
 * uses for TodoWrite — see todo-render.ts).
 *
 * The wire path is the daemon's `friday-elicitation/ask_user` MCP tool;
 * the tool_use block (questions) and tool_result block (answer) both
 * land in the canonical `blocks` table and replicate via Zero. Lock-
 * state on reload derives from `msg.output` being populated — no marker
 * codec, no ephemeral state outside the message thread.
 */

/** Option in a single question (1-5 word label, description, optional
 *  preview content). Schema mirrors `mcp__friday-elicitation__ask_user`'s
 *  input declaration in `services/daemon/src/mcp/elicitation.ts`. */
export interface AUQOption {
  label: string;
  description: string;
  preview?: string;
}

/** A single question in the panel (1-4 questions per `ask_user` call). */
export interface AUQQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AUQOption[];
}

/** Per-question answer the model receives. The `kind` discriminator lets
 *  the model distinguish 'user picked from my options' from 'user typed
 *  something I didn't list'; the daemon-side MCP handler returns this
 *  verbatim. For multi-select the `value` is comma+space joined in
 *  selection order; if any of the picks came from Other (free-form),
 *  `kind` is `"other"` for the whole answer. */
export interface AUQAnswer {
  kind: "option" | "other";
  value: string;
}

/** Structured answer payload posted to `/api/elicitation/<id>/submit`.
 *  Mirrors the daemon-side return type the MCP handler ships back to the
 *  SDK as the `tool_result` text content. */
export interface AUQAnswerPayload {
  answers: Record<string, AUQAnswer>;
  annotations?: Record<string, { notes?: string }>;
}

/** Selection state the panel maintains in memory before submit. Keyed by
 *  the question string. `selectedLabels` is the empty list until the user
 *  picks something; `otherText` is non-empty only when the user picked
 *  the synthesized "Other" affordance. */
export interface AUQSelectionState {
  selectedLabels: string[];
  otherText: string;
  notes: string;
}

/** The synthesized "Other" option always carries this label. Sentinel
 *  for the discriminator: any selection containing OTHER_LABEL with a
 *  non-empty `otherText` flips the answer's `kind` to `"other"`. */
export const OTHER_LABEL = "Other";

/* ---------------- input parsing ---------------- */

/** Defensive parse of a `tool_use.input` for `ask_user` (or the SDK
 *  built-in `AskUserQuestion`, whose schema is structurally identical).
 *  Model-controlled input — never throw. Returns `[]` for any shape
 *  that isn't `{ questions: [{ ... }] }` with at least one valid question.
 *
 *  Per-row validation is structural (string types, non-empty options).
 *  We do NOT enforce the SDK's 1-4 / 2-4 limits at parse time: the model
 *  emitted the call, the user is going to see whatever the model said.
 *  Rendering bad input as an empty panel would be worse than rendering
 *  a panel with 5 options. */
export function parseQuestions(input: unknown): AUQQuestion[] {
  if (input === null || typeof input !== "object") return [];
  const root = input as { questions?: unknown };
  if (!Array.isArray(root.questions)) return [];
  const out: AUQQuestion[] = [];
  for (const raw of root.questions) {
    if (raw === null || typeof raw !== "object") continue;
    const q = raw as {
      question?: unknown;
      header?: unknown;
      multiSelect?: unknown;
      options?: unknown;
    };
    if (typeof q.question !== "string" || q.question.length === 0) continue;
    if (typeof q.header !== "string") continue;
    if (!Array.isArray(q.options)) continue;
    const options: AUQOption[] = [];
    for (const optRaw of q.options) {
      if (optRaw === null || typeof optRaw !== "object") continue;
      const o = optRaw as { label?: unknown; description?: unknown; preview?: unknown };
      if (typeof o.label !== "string" || o.label.length === 0) continue;
      if (typeof o.description !== "string") continue;
      const opt: AUQOption = { label: o.label, description: o.description };
      if (typeof o.preview === "string" && o.preview.length > 0) opt.preview = o.preview;
      options.push(opt);
    }
    if (options.length === 0) continue;
    out.push({
      question: q.question,
      header: q.header,
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return out;
}

/* ---------------- payload shaping ---------------- */

/** Build the `{ answers, annotations }` payload posted to the daemon's
 *  submit endpoint. Per-question answer carries `{kind, value}`:
 *
 *  - All picks are listed options (no Other, or Other with no text):
 *    `kind: "option"`, `value` is comma-joined labels in pick order.
 *  - Any pick is Other with non-empty text: `kind: "other"`, `value` is
 *    comma-joined labels and free-form text in pick order (Other-with-
 *    no-text picks drop out).
 *
 *  Annotations are emitted (the whole field, not just per-question)
 *  only when at least one question carries a non-empty `notes`.
 */
export function buildAnswerPayload(
  questions: AUQQuestion[],
  selection: Record<string, AUQSelectionState>,
): AUQAnswerPayload {
  const answers: Record<string, AUQAnswer> = {};
  const annotations: Record<string, { notes?: string }> = {};
  let annotationsHasContent = false;
  for (const q of questions) {
    const state = selection[q.question] ?? { selectedLabels: [], otherText: "", notes: "" };
    const parts: string[] = [];
    let otherFlipped = false;
    for (const label of state.selectedLabels) {
      if (label === OTHER_LABEL) {
        const trimmed = state.otherText.trim();
        if (trimmed.length > 0) {
          parts.push(trimmed);
          otherFlipped = true;
        }
      } else {
        parts.push(label);
      }
    }
    answers[q.question] = {
      kind: otherFlipped ? "other" : "option",
      value: parts.join(", "),
    };
    const notesTrimmed = state.notes.trim();
    if (notesTrimmed.length > 0) {
      annotations[q.question] = { notes: notesTrimmed };
      annotationsHasContent = true;
    }
  }
  const payload: AUQAnswerPayload = { answers };
  if (annotationsHasContent) payload.annotations = annotations;
  return payload;
}

/** True when the panel has enough input to submit — every question has at
 *  least one selection OR the synthesized "Other" affordance carries a
 *  non-empty text input. */
export function isSubmissionReady(
  questions: AUQQuestion[],
  selection: Record<string, AUQSelectionState>,
): boolean {
  if (questions.length === 0) return false;
  for (const q of questions) {
    const state = selection[q.question];
    if (!state) return false;
    const labels = state.selectedLabels;
    if (labels.length === 0) return false;
    // Picking "Other" alone with no text isn't a real answer.
    if (labels.length === 1 && labels[0] === OTHER_LABEL && state.otherText.trim().length === 0) {
      return false;
    }
  }
  return true;
}

/* ---------------- locked-state helpers ---------------- */

/** Parse the canonical `tool_result` text the MCP handler emitted. The
 *  handler echoes the questions + answers + annotations as JSON; we
 *  extract the answers / annotations halves to drive the locked-panel
 *  selection rehydration. Returns null when the text isn't a parseable
 *  echo (e.g. an error tool_result, a built-in AskUserQuestion auto-
 *  failure string, a `{tool_use_id, text: "..."}` stub) — caller falls
 *  back to a generic "answered" rendering with no highlighted picks.
 */
export function parseToolResultOutput(text: string | undefined): AUQAnswerPayload | null {
  if (typeof text !== "string" || text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as { answers?: unknown; annotations?: unknown };
  if (obj.answers === null || typeof obj.answers !== "object") return null;
  const answers: Record<string, AUQAnswer> = {};
  for (const k of Object.keys(obj.answers)) {
    const a = (obj.answers as Record<string, unknown>)[k];
    if (a === null || typeof a !== "object") return null;
    const ax = a as { kind?: unknown; value?: unknown };
    if (ax.kind !== "option" && ax.kind !== "other") return null;
    if (typeof ax.value !== "string") return null;
    answers[k] = { kind: ax.kind, value: ax.value };
  }
  const payload: AUQAnswerPayload = { answers };
  if (obj.annotations && typeof obj.annotations === "object") {
    const annotations: Record<string, { notes?: string }> = {};
    let any = false;
    for (const k of Object.keys(obj.annotations)) {
      const v = (obj.annotations as Record<string, unknown>)[k];
      if (v === null || typeof v !== "object") continue;
      const vx = v as { notes?: unknown };
      if (typeof vx.notes === "string" && vx.notes.length > 0) {
        annotations[k] = { notes: vx.notes };
        any = true;
      }
    }
    if (any) payload.annotations = annotations;
  }
  return payload;
}

/** Re-hydrate panel selection state from a previously-submitted payload —
 *  used to render the locked panel after reload (or in another tab) with
 *  the user's selections highlighted. */
export function selectionFromPayload(
  questions: AUQQuestion[],
  payload: AUQAnswerPayload,
): Record<string, AUQSelectionState> {
  const out: Record<string, AUQSelectionState> = {};
  for (const q of questions) {
    const answer = payload.answers[q.question];
    const raw = answer?.value ?? "";
    const labelSet = new Set(q.options.map((o) => o.label));
    const parts = raw.length > 0 ? raw.split(", ") : [];
    const selectedLabels: string[] = [];
    let otherText = "";
    for (const part of parts) {
      if (labelSet.has(part)) {
        selectedLabels.push(part);
      } else if (part.length > 0) {
        // Anything not in the option list was supplied via "Other".
        selectedLabels.push(OTHER_LABEL);
        otherText = otherText.length > 0 ? `${otherText}, ${part}` : part;
      }
    }
    const notes = payload.annotations?.[q.question]?.notes ?? "";
    out[q.question] = { selectedLabels, otherText, notes };
  }
  return out;
}
