<script lang="ts">
  import { Send, Check } from "lucide-svelte";
  import {
    OTHER_LABEL,
    buildAnswerPayload,
    isSubmissionReady,
    parseQuestions,
    parseToolResultOutput,
    selectionFromPayload,
    type AUQQuestion,
    type AUQSelectionState,
  } from "./ask-user-question";
  import type { ToolRendererProps } from "./tool-renderers";

  // FRI-152 — interactive panel for the Friday MCP tool
  // `friday-elicitation/ask_user` (which supersedes the SDK built-in
  // AskUserQuestion in this headless environment; the built-in is denied
  // at the PreToolUse layer with a redirect message to this MCP tool).
  // Registered against the dispatch registry's MCP short key `"ask_user"`
  // (see tool-renderers.ts).
  //
  // Wire path: the worker's MCP handler long-polls
  // `/api/elicitation/<toolUseId>/wait`; the daemon emits an
  // `elicitation_requested` SSE event when the waiter registers. The
  // panel renders from `msg.input` (the canonical tool_use's questions
  // payload, already replicated via Zero); on submit, the panel POSTs
  // `/api/elicitation/<toolUseId>/submit` with the answer payload, the
  // daemon resolves the waiter, the MCP handler returns, and the SDK
  // emits a normal `tool_result` block. The panel locks once `msg.output`
  // is populated (the canonical tool_result lands via Zero). No marker
  // codec; no state outside the message thread.
  let {
    input,
    status,
    output,
    toolId,
    toolName: _toolName,
    friendlyName: _friendlyName,
    inputPartialJson: _inputPartialJson,
  }: ToolRendererProps = $props();

  let questions: AUQQuestion[] = $derived(parseQuestions(input));

  // Locked when the MCP tool's tool_result has landed (output populated)
  // AND the output text decodes as our structured echo. An error result
  // (PreToolUse deny for the built-in, MCP handler aborted, etc.) decodes
  // to null — we still render the panel as locked-without-selections so
  // the user sees their prior request didn't succeed.
  let lockedAnswer = $derived(parseToolResultOutput(output));
  let lockedNoAnswer = $derived(
    !lockedAnswer && typeof output === "string" && output.length > 0,
  );
  let locked = $derived(!!lockedAnswer || lockedNoAnswer);

  // Per-question selection state.
  let selection = $state<Record<string, AUQSelectionState>>({});
  let lastInitKey = "";
  $effect(() => {
    const tid = toolId ?? "";
    const lockedKey = lockedAnswer ? "L" : locked ? "E" : "U";
    const key = `${tid}|${lockedKey}`;
    if (key === lastInitKey) return;
    lastInitKey = key;
    if (lockedAnswer) {
      selection = selectionFromPayload(questions, lockedAnswer);
    } else {
      const fresh: Record<string, AUQSelectionState> = {};
      for (const q of questions) {
        fresh[q.question] = { selectedLabels: [], otherText: "", notes: "" };
      }
      selection = fresh;
    }
  });

  let notesOpen = $state<Record<string, boolean>>({});
  $effect(() => {
    if (!lockedAnswer) return;
    const next: Record<string, boolean> = {};
    for (const q of questions) {
      const annotated = lockedAnswer.annotations?.[q.question]?.notes;
      if (typeof annotated === "string" && annotated.length > 0) next[q.question] = true;
    }
    notesOpen = next;
  });

  // Tracks an in-flight submit POST so the button can show progress and
  // we don't double-fire on rapid clicks.
  let submitting = $state(false);
  let submitError = $state<string | null>(null);

  let canSubmit = $derived(!locked && !submitting && isSubmissionReady(questions, selection));

  function ensureState(q: string): AUQSelectionState {
    let s = selection[q];
    if (!s) {
      s = { selectedLabels: [], otherText: "", notes: "" };
      selection[q] = s;
    }
    return s;
  }

  function toggleLabel(q: AUQQuestion, label: string) {
    if (locked) return;
    const s = ensureState(q.question);
    if (q.multiSelect) {
      const i = s.selectedLabels.indexOf(label);
      if (i === -1) s.selectedLabels = [...s.selectedLabels, label];
      else s.selectedLabels = s.selectedLabels.filter((_, idx) => idx !== i);
    } else {
      s.selectedLabels = [label];
    }
  }

  function setOtherText(q: AUQQuestion, value: string) {
    if (locked) return;
    const s = ensureState(q.question);
    s.otherText = value;
    if (s.otherText.length > 0 && !s.selectedLabels.includes(OTHER_LABEL)) {
      if (q.multiSelect) {
        s.selectedLabels = [...s.selectedLabels, OTHER_LABEL];
      } else {
        s.selectedLabels = [OTHER_LABEL];
      }
    }
  }

  function setNotes(q: AUQQuestion, value: string) {
    if (locked) return;
    const s = ensureState(q.question);
    s.notes = value;
  }

  async function submit() {
    if (!canSubmit || !toolId) return;
    submitting = true;
    submitError = null;
    const payload = buildAnswerPayload(questions, selection);
    try {
      const res = await fetch(`/api/elicitation/${encodeURIComponent(toolId)}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        submitError = errBody.error ?? `submit failed (${res.status})`;
        submitting = false;
        return;
      }
      // Success: the panel doesn't flip to locked from here — it waits for
      // the canonical tool_result block to replicate via Zero, which then
      // populates `msg.output` and the derived `lockedAnswer` rerenders
      // the panel as locked. Keep the submit button disabled in the
      // meantime so the user can't double-fire.
    } catch (e) {
      submitError = (e as Error).message;
      submitting = false;
    }
  }

  function isLabelSelected(q: AUQQuestion, label: string): boolean {
    return (selection[q.question]?.selectedLabels ?? []).includes(label);
  }
</script>

<div class="auq-panel" data-tool-id={toolId} data-locked={locked ? "1" : "0"}>
  {#if questions.length === 0}
    <div class="auq-empty">ask_user received malformed input — nothing to render.</div>
  {:else}
    <div class="auq-header">
      <span class="auq-icon" aria-hidden="true">?</span>
      <span class="auq-title">{locked ? "Answered" : "Friday asks"}</span>
      {#if status === "error" || status === "aborted"}
        <span class="auq-badge auq-badge-warn">{status}</span>
      {/if}
    </div>

    <ul class="auq-questions">
      {#each questions as q (q.question)}
        {@const state = selection[q.question] ?? { selectedLabels: [], otherText: "", notes: "" }}
        {@const name = `auq-${toolId ?? "x"}-${q.question}`}
        <li class="auq-question">
          <fieldset class="auq-fieldset" disabled={locked || submitting}>
            <legend class="auq-legend">
              <span class="auq-header-chip" title={q.header}>{q.header}</span>
              <span class="auq-question-text">{q.question}</span>
              {#if q.multiSelect}
                <span class="auq-multi-hint">(multi-select)</span>
              {/if}
            </legend>

            <div class="auq-options">
              {#each q.options as opt (opt.label)}
                {@const checked = isLabelSelected(q, opt.label)}
                <label
                  class="auq-option"
                  class:checked
                  data-checked={checked ? "1" : "0"}>
                  <input
                    type={q.multiSelect ? "checkbox" : "radio"}
                    {name}
                    value={opt.label}
                    {checked}
                    disabled={locked || submitting}
                    onchange={() => toggleLabel(q, opt.label)}
                    aria-describedby={`${name}-${opt.label}-desc`} />
                  <span class="auq-option-body">
                    <span class="auq-option-label">{opt.label}</span>
                    {#if opt.description}
                      <span class="auq-option-desc" id={`${name}-${opt.label}-desc`}>
                        {opt.description}
                      </span>
                    {/if}
                    {#if opt.preview}
                      <details class="auq-option-preview">
                        <summary>Preview</summary>
                        <pre class="auq-option-preview-body">{opt.preview}</pre>
                      </details>
                    {/if}
                  </span>
                </label>
              {/each}

              <!-- Synthesized "Other" affordance. The dashboard always
                   renders this (per the FRI-152 protocol fragment, the
                   model is told NOT to include an Other option). The
                   membership check is inlined rather than hoisted to a
                   `{@const}` because `{@const}` only sits inside
                   control-flow blocks. -->
              <label
                class="auq-option auq-option-other"
                class:checked={state.selectedLabels.includes(OTHER_LABEL)}
                data-checked={state.selectedLabels.includes(OTHER_LABEL) ? "1" : "0"}>
                <input
                  type={q.multiSelect ? "checkbox" : "radio"}
                  {name}
                  value={OTHER_LABEL}
                  checked={state.selectedLabels.includes(OTHER_LABEL)}
                  disabled={locked || submitting}
                  onchange={() => toggleLabel(q, OTHER_LABEL)} />
                <span class="auq-option-body">
                  <span class="auq-option-label">{OTHER_LABEL}</span>
                  <input
                    type="text"
                    class="auq-other-input"
                    placeholder="Type your own answer"
                    value={state.otherText}
                    disabled={locked || submitting}
                    oninput={(e) => setOtherText(q, (e.currentTarget as HTMLInputElement).value)} />
                </span>
              </label>
            </div>

            <div class="auq-notes-row">
              {#if !locked}
                <button
                  type="button"
                  class="auq-notes-toggle"
                  aria-expanded={notesOpen[q.question] ? "true" : "false"}
                  onclick={() => (notesOpen[q.question] = !notesOpen[q.question])}>
                  {notesOpen[q.question] ? "−" : "+"} Add note
                </button>
              {/if}
              {#if notesOpen[q.question] || (locked && state.notes.length > 0)}
                {#if locked}
                  <p class="auq-notes-locked">{state.notes}</p>
                {:else}
                  <textarea
                    class="auq-notes-input"
                    rows="2"
                    placeholder="Optional context for this answer"
                    value={state.notes}
                    oninput={(e) =>
                      setNotes(q, (e.currentTarget as HTMLTextAreaElement).value)}
                  ></textarea>
                {/if}
              {/if}
            </div>
          </fieldset>
        </li>
      {/each}
    </ul>

    {#if locked && lockedAnswer}
      <div class="auq-footer auq-footer-locked">
        <Check size={14} aria-hidden="true" />
        <span>Submitted</span>
      </div>
    {:else if lockedNoAnswer}
      <div class="auq-footer auq-footer-locked auq-footer-error">
        <span>Tool result returned without a structured answer.</span>
      </div>
    {:else}
      <div class="auq-footer">
        {#if submitError}
          <span class="auq-error">{submitError}</span>
        {/if}
        <button
          type="button"
          class="auq-submit"
          disabled={!canSubmit}
          onclick={submit}>
          <Send size={14} aria-hidden="true" />
          {submitting ? "Submitting…" : "Submit answers"}
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .auq-panel {
    border-left: 2px solid var(--accent-primary);
    padding: 0.6rem 0.75rem;
    background: var(--bg-card);
    border-radius: var(--radius-md);
    border-top: 1px solid var(--border-subtle);
    border-right: 1px solid var(--border-subtle);
    border-bottom: 1px solid var(--border-subtle);
    box-shadow: var(--shadow-sm);
    font-size: 0.85rem;
  }
  .auq-empty {
    color: var(--text-tertiary);
    font-style: italic;
    padding: 0.4rem;
  }
  .auq-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .auq-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 999px;
    background: var(--accent-primary);
    color: var(--text-inverse);
    font-weight: 700;
    font-size: 0.8rem;
  }
  .auq-title {
    font-weight: 600;
    color: var(--text-primary);
  }
  .auq-badge {
    margin-left: auto;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm);
  }
  .auq-badge-warn {
    background: color-mix(in srgb, var(--status-warn) 30%, transparent);
    color: var(--text-primary);
  }
  .auq-questions {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .auq-question {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg-secondary, var(--bg-card));
    padding: 0.5rem 0.6rem;
  }
  .auq-fieldset {
    border: none;
    margin: 0;
    padding: 0;
    min-width: 0;
  }
  .auq-fieldset[disabled] {
    opacity: 0.85;
  }
  .auq-legend {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    padding: 0 0 0.35rem 0;
  }
  .auq-header-chip {
    display: inline-block;
    max-width: 14ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.7rem;
    padding: 0.05rem 0.4rem;
    background: var(--bg-tertiary);
    color: var(--text-tertiary);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
  }
  .auq-question-text {
    color: var(--text-primary);
    font-weight: 500;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .auq-multi-hint {
    font-size: 0.7rem;
    color: var(--text-tertiary);
    font-style: italic;
  }
  .auq-options {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .auq-option {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.6rem 0.65rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-card);
    cursor: pointer;
    min-height: 44px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .auq-option:hover:not([data-checked="1"]) {
    border-color: var(--accent-muted, var(--accent-primary));
    background: var(--bg-tertiary);
  }
  .auq-option.checked,
  .auq-option[data-checked="1"] {
    border-color: var(--accent-primary);
    background: color-mix(in srgb, var(--accent-primary) 8%, var(--bg-card));
  }
  .auq-option input[type="radio"],
  .auq-option input[type="checkbox"] {
    margin-top: 0.2rem;
    accent-color: var(--accent-primary);
    flex-shrink: 0;
  }
  .auq-option-body {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
    flex: 1;
  }
  .auq-option-label {
    font-weight: 500;
    color: var(--text-primary);
  }
  .auq-option-desc {
    color: var(--text-secondary);
    font-size: 0.78rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .auq-option-preview {
    margin-top: 0.25rem;
  }
  .auq-option-preview summary {
    cursor: pointer;
    font-size: 0.7rem;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .auq-option-preview-body {
    margin: 0.35rem 0 0;
    padding: 0.5rem 0.6rem;
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text-secondary);
  }
  .auq-other-input {
    margin-top: 0.25rem;
    width: 100%;
    padding: 0.45rem 0.55rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    font: inherit;
    min-height: 44px;
  }
  .auq-other-input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }
  .auq-notes-row {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-top: 0.5rem;
  }
  .auq-notes-toggle {
    align-self: flex-start;
    background: transparent;
    border: none;
    color: var(--text-tertiary);
    font: inherit;
    font-size: 0.75rem;
    padding: 0.25rem 0;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    min-height: 32px;
  }
  .auq-notes-toggle:hover {
    color: var(--text-secondary);
  }
  .auq-notes-input {
    width: 100%;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    font: inherit;
    resize: vertical;
  }
  .auq-notes-input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }
  .auq-notes-locked {
    margin: 0;
    padding: 0.4rem 0.55rem;
    background: var(--bg-tertiary);
    border-left: 2px solid var(--accent-primary);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 0.78rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .auq-footer {
    margin-top: 0.75rem;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .auq-error {
    color: var(--status-error);
    font-size: 0.75rem;
  }
  .auq-submit {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.55rem 0.95rem;
    background: var(--accent-primary);
    color: var(--text-inverse);
    border: none;
    border-radius: var(--radius-md);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    min-height: 44px;
  }
  .auq-submit:disabled {
    background: var(--bg-tertiary);
    color: var(--text-tertiary);
    cursor: not-allowed;
  }
  .auq-submit:not(:disabled):hover {
    filter: brightness(1.05);
  }
  .auq-footer-locked {
    color: var(--text-secondary);
    font-size: 0.78rem;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    margin-top: 0.5rem;
  }
  .auq-footer-error {
    color: var(--status-error);
  }
  @media (max-width: 1023px) {
    .auq-other-input,
    .auq-notes-input {
      font-size: 16px;
    }
  }
</style>
