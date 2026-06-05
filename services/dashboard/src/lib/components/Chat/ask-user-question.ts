/**
 * Pure logic seam for the AskUserQuestion renderer (FRI-152).
 *
 * Everything in here is ts-only — no Svelte, no DOM. The companion
 * `AskUserQuestionPanel.svelte` calls these for input parsing, payload
 * shaping, and marker encode/decode. Keeping the logic out of the
 * component lets the node-pool vitest suite pin behavior with full
 * coverage without standing up a DOM harness (same pattern todo-render
 * uses for TodoWrite — see todo-render.ts).
 *
 * The marker convention encodes the structured answer in the user
 * message body so reload-after-submit rehydrates the locked-panel state
 * from the message thread alone (CLAUDE.md global rule:
 * "Don't store ephemeral state outside the message thread"). User
 * messages render as plain text in ChatMessages.svelte, so we encode the
 * payload as a single-line, base64-wrapped suffix that the chat-store
 * parser strips before display.
 */

/** SDK AskUserQuestion option (one of 2-4 per question). */
export interface AUQOption {
  label: string;
  description: string;
  preview?: string;
}

/** SDK AskUserQuestion question (one of 1-4 per call). */
export interface AUQQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AUQOption[];
}

/** Structured answer payload returned to the model. The SDK schema types
 *  `answers[question]` as `string`; for multi-select we join labels with
 *  a `, ` delimiter (human-readable AND parser-stable). */
export interface AUQAnswerPayload {
  toolUseId: string;
  answers: Record<string, string>;
  annotations?: Record<string, { notes?: string; preview?: string }>;
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

/** Sentinel used to separate the human-readable answer summary from the
 *  base64 payload in the user-message text body. Picked to be vanishingly
 *  unlikely to appear in organic chat content. */
export const AUQ_MARKER = "@@AUQ-ANSWER@@";

/** The synthesized "Other" option always carries this label. Lowercase
 *  variants land in `answers` as the user's free-text input verbatim; the
 *  visible label is just the affordance. */
export const OTHER_LABEL = "Other";

/* ---------------- input parsing ---------------- */

/** Defensive parse of the SDK's `tool_use.input` for AskUserQuestion.
 *  Model-controlled input — never throw. Returns `[]` for any shape that
 *  isn't `{ questions: [{ ... }] }` with at least one valid question.
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

/** Build the structured `{ toolUseId, answers, annotations }` payload from
 *  the panel's in-memory selection state. Pure — no I/O.
 *
 *  Multi-select answers join the chosen labels with `, ` (comma + space).
 *  This matches typical Anthropic conventions (human-readable, no quoting,
 *  no JSON arrays-as-strings) and keeps `answers[Q]: string` honoring the
 *  SDK schema.
 *
 *  "Other" answers fold the user-typed text in as the literal value — no
 *  `Other: ` prefix, no quoting. The model sees exactly what the user
 *  typed in `answers[Q]`. If "Other" is also picked alongside a listed
 *  option (multi-select), the literal text is joined with the labels in
 *  selection order.
 *
 *  Annotations are omitted (the whole field, not just per-question) when
 *  no question carries a non-empty `notes`.
 */
export function buildAnswerPayload(
  toolUseId: string,
  questions: AUQQuestion[],
  selection: Record<string, AUQSelectionState>,
): AUQAnswerPayload {
  const answers: Record<string, string> = {};
  const annotations: Record<string, { notes?: string; preview?: string }> = {};
  let annotationsHasContent = false;
  for (const q of questions) {
    const state = selection[q.question] ?? { selectedLabels: [], otherText: "", notes: "" };
    const parts: string[] = [];
    for (const label of state.selectedLabels) {
      if (label === OTHER_LABEL) {
        const trimmed = state.otherText.trim();
        if (trimmed.length > 0) parts.push(trimmed);
      } else {
        parts.push(label);
      }
    }
    answers[q.question] = parts.join(", ");
    const notesTrimmed = state.notes.trim();
    if (notesTrimmed.length > 0) {
      annotations[q.question] = { notes: notesTrimmed };
      annotationsHasContent = true;
    }
  }
  const payload: AUQAnswerPayload = { toolUseId, answers };
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

/* ---------------- human-readable summary ---------------- */

/** Compose the visible user-message text — one bullet per question, the
 *  selected label(s) and inline notes. This is what the chat bubble
 *  renders; it's also the only thing the model sees as user input on its
 *  next turn (the marker is dashboard-only metadata). */
export function formatHumanReadableAnswer(
  questions: AUQQuestion[],
  payload: AUQAnswerPayload,
): string {
  const lines: string[] = [];
  for (const q of questions) {
    const answer = payload.answers[q.question] ?? "";
    const note = payload.annotations?.[q.question]?.notes;
    let line = `- ${q.header || q.question}: ${answer || "(no answer)"}`;
    if (note && note.length > 0) line += ` — note: ${note}`;
    lines.push(line);
  }
  return lines.join("\n");
}

/* ---------------- marker codec ---------------- */

/** Base64 codec that's safe in both Node (Buffer) and browser (btoa/atob)
 *  contexts. The marker payload is small (a handful of strings) so we
 *  don't need streaming; a single round-trip suffices.
 *
 *  We base64 the JSON (not embed it raw) so a literal `@@AUQ-ANSWER@@`
 *  inside a user note can't defeat the parser, and so the suffix is one
 *  uninterrupted line for trivial endsWith / split parsing. */
function encodeBase64(s: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(s, "utf8").toString("base64");
  }
  // Browser fallback. btoa expects latin-1; encode UTF-8 first.
  const utf8 = unescape(encodeURIComponent(s));
  return btoa(utf8);
}

function decodeBase64(s: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(s, "base64").toString("utf8");
  }
  return decodeURIComponent(escape(atob(s)));
}

/** Build the full user-message body — human-readable summary followed by
 *  the marker + base64 payload suffix on its own line. */
export function formatAnswerMessageBody(
  questions: AUQQuestion[],
  payload: AUQAnswerPayload,
): string {
  const summary = formatHumanReadableAnswer(questions, payload);
  const marker = `${AUQ_MARKER}${encodeBase64(JSON.stringify(payload))}`;
  return `${summary}\n\n${marker}`;
}

/** Detect + extract the marker from a user-message text. Returns the
 *  stripped display text and the parsed payload, or `null` if the marker
 *  isn't present or is malformed (no throw — the parser is best-effort).
 *
 *  Idempotent: a text without the marker returns null and the caller
 *  uses the original text unchanged. */
export function parseAnswerMessageBody(
  text: string,
): { displayText: string; payload: AUQAnswerPayload } | null {
  if (typeof text !== "string") return null;
  const idx = text.lastIndexOf(AUQ_MARKER);
  if (idx === -1) return null;
  const encoded = text.slice(idx + AUQ_MARKER.length).trim();
  if (encoded.length === 0) return null;
  let json: string;
  try {
    json = decodeBase64(encoded);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isValidPayload(parsed)) return null;
  // Strip the marker line AND the preceding blank line separator (if
  // present) so the visible text doesn't end with stray whitespace.
  let displayText = text.slice(0, idx);
  if (displayText.endsWith("\n\n")) displayText = displayText.slice(0, -2);
  else if (displayText.endsWith("\n")) displayText = displayText.slice(0, -1);
  return { displayText, payload: parsed };
}

function isValidPayload(v: unknown): v is AUQAnswerPayload {
  if (v === null || typeof v !== "object") return false;
  const obj = v as { toolUseId?: unknown; answers?: unknown; annotations?: unknown };
  if (typeof obj.toolUseId !== "string" || obj.toolUseId.length === 0) return false;
  if (obj.answers === null || typeof obj.answers !== "object") return false;
  for (const k of Object.keys(obj.answers)) {
    const val = (obj.answers as Record<string, unknown>)[k];
    if (typeof val !== "string") return false;
  }
  if (obj.annotations !== undefined) {
    if (obj.annotations === null || typeof obj.annotations !== "object") return false;
    for (const k of Object.keys(obj.annotations)) {
      const a = (obj.annotations as Record<string, unknown>)[k];
      if (a === null || typeof a !== "object") return false;
      const ax = a as { notes?: unknown; preview?: unknown };
      if (ax.notes !== undefined && typeof ax.notes !== "string") return false;
      if (ax.preview !== undefined && typeof ax.preview !== "string") return false;
    }
  }
  return true;
}

/* ---------------- locked-state helpers ---------------- */

/** Re-hydrate panel selection state from a previously-submitted payload —
 *  used to render the locked panel after reload (or in another tab) with
 *  the user's selections highlighted. */
export function selectionFromPayload(
  questions: AUQQuestion[],
  payload: AUQAnswerPayload,
): Record<string, AUQSelectionState> {
  const out: Record<string, AUQSelectionState> = {};
  for (const q of questions) {
    const raw = payload.answers[q.question] ?? "";
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
