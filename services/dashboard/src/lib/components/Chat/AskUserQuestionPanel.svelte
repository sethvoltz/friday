<script lang="ts">
  import { Send, Check } from "lucide-svelte";
  import { chat } from "$lib/stores/chat.svelte";
  import {
    OTHER_LABEL,
    isSubmissionReady,
    parseQuestions,
    selectionFromPayload,
    type AUQQuestion,
    type AUQSelectionState,
  } from "./ask-user-question";
  import type { ToolRendererProps } from "./tool-renderers";

  // FRI-152 — interactive panel for the Claude Agent SDK's `AskUserQuestion`
  // tool. Registered against the dispatch registry's literal key
  // `"AskUserQuestion"` (see tool-renderers.ts). Renders the model's
  // structured questions as clickable cards; on submit, pipes the
  // structured answer back through the existing `sendUserMessage` mutator
  // path — the dashboard does NOT inject a synthetic tool_result into the
  // SDK's already-paused turn (no such hook exists in the daemon's worker;
  // see the FRI-152 ticket's "Investigation findings" comment). The user's
  // answer surfaces to the model as a fresh user turn carrying the
  // human-readable summary; reload-rehydration of the locked panel uses a
  // base64 marker rider on the persisted user-message body (no state
  // outside the message thread).
  //
  // Accepts ALL ToolRendererProps fields so the dispatch-site prop spread
  // in ChatMessages.svelte typechecks. Only `input`, `status`, `output`,
  // and `toolId` are used — `friendlyName` / `inputPartialJson` are unused
  // here.
  let {
    input,
    status,
    output: _output,
    toolId,
    toolName: _toolName,
    friendlyName: _friendlyName,
    inputPartialJson: _inputPartialJson,
  }: ToolRendererProps = $props();

  let questions: AUQQuestion[] = $derived(parseQuestions(input));

  // Look for a previously-submitted answer on a downstream user message —
  // that's the lock-state signal. We deliberately do NOT lock on the SDK's
  // own tool_result (which in this headless context is typically an auto-
  // failed "no UI" error, not a real answer); the user should still get to
  // record their answer for the model's next turn even after that failure.
  let lockedAnswer = $derived.by(() => {
    if (!toolId) return null;
    for (const m of chat.messages) {
      if (m.askUserQuestionAnswer?.toolUseId === toolId) {
        return m.askUserQuestionAnswer;
      }
    }
    return null;
  });

  // Per-question selection state. Rehydrate from the locked answer when
  // one is present (so the locked panel highlights what the user actually
  // picked); otherwise start blank.
  let selection = $state<Record<string, AUQSelectionState>>({});
  let lastInitForToolId = "";
  $effect(() => {
    // Re-init whenever the panel's toolId changes (a new AskUserQuestion
    // tool_use mounted) OR a locked answer arrives. Both transitions
    // should reset selection to the canonical state for THIS panel.
    const tid = toolId ?? "";
    const lockedKey = lockedAnswer ? "L" : "U";
    const key = `${tid}|${lockedKey}`;
    if (key === lastInitForToolId) return;
    lastInitForToolId = key;
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
    // Pre-open the notes disclosure on locked panels that carry a note,
    // so the user sees what they wrote without having to click.
    if (!lockedAnswer) return;
    const next: Record<string, boolean> = {};
    for (const q of questions) {
      const annotated = lockedAnswer.annotations?.[q.question]?.notes;
      if (typeof annotated === "string" && annotated.length > 0) next[q.question] = true;
    }
    notesOpen = next;
  });

  let canSubmit = $derived(!lockedAnswer && isSubmissionReady(questions, selection));

  function ensureState(q: string): AUQSelectionState {
    let s = selection[q];
    if (!s) {
      s = { selectedLabels: [], otherText: "", notes: "" };
      selection[q] = s;
    }
    return s;
  }

  function toggleLabel(q: AUQQuestion, label: string) {
    if (lockedAnswer) return;
    const s = ensureState(q.question);
    if (q.multiSelect) {
      const i = s.selectedLabels.indexOf(label);
      if (i === -1) s.selectedLabels = [...s.selectedLabels, label];
      else s.selectedLabels = s.selectedLabels.filter((_, idx) => idx !== i);
    } else {
      // Single-select: clicking the already-selected option is a no-op,
      // not a deselect — radio semantics.
      s.selectedLabels = [label];
    }
  }

  function setOtherText(q: AUQQuestion, value: string) {
    if (lockedAnswer) return;
    const s = ensureState(q.question);
    s.otherText = value;
    // First keystroke after picking Other counts as a positive selection;
    // typing into Other when Other isn't yet selected auto-selects it
    // (saves a click on mobile).
    if (s.otherText.length > 0 && !s.selectedLabels.includes(OTHER_LABEL)) {
      if (q.multiSelect) {
        s.selectedLabels = [...s.selectedLabels, OTHER_LABEL];
      } else {
        s.selectedLabels = [OTHER_LABEL];
      }
    }
  }

  function setNotes(q: AUQQuestion, value: string) {
    if (lockedAnswer) return;
    const s = ensureState(q.question);
    s.notes = value;
  }

  function submit() {
    if (!canSubmit || !toolId) return;
    chat.submitAskUserQuestionAnswer({ toolUseId: toolId, questions, selection });
  }

  function isLabelSelected(q: AUQQuestion, label: string): boolean {
    return (selection[q.question]?.selectedLabels ?? []).includes(label);
  }
</script>

<div class="auq-panel" data-tool-id={toolId} data-locked={lockedAnswer ? "1" : "0"}>
  {#if questions.length === 0}
    <div class="auq-empty">AskUserQuestion received malformed input — nothing to render.</div>
  {:else}
    <div class="auq-header">
      <span class="auq-icon" aria-hidden="true">?</span>
      <span class="auq-title">{lockedAnswer ? "Answered" : "Friday asks"}</span>
      {#if status === "error" || status === "aborted"}
        <span class="auq-badge auq-badge-warn">{status}</span>
      {/if}
    </div>

    <ul class="auq-questions">
      {#each questions as q (q.question)}
        {@const state = selection[q.question] ?? { selectedLabels: [], otherText: "", notes: "" }}
        {@const name = `auq-${toolId ?? "x"}-${q.question}`}
        <li class="auq-question">
          <fieldset class="auq-fieldset" disabled={!!lockedAnswer}>
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
                    disabled={!!lockedAnswer}
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

              <!-- Synthesized "Other" affordance. Per the SDK spec the
                   runtime auto-provides Other; in this headless context
                   the dashboard owns the rendering, so we always include
                   it. -->
              {@const otherChecked = state.selectedLabels.includes(OTHER_LABEL)}
              <label
                class="auq-option auq-option-other"
                class:checked={otherChecked}
                data-checked={otherChecked ? "1" : "0"}>
                <input
                  type={q.multiSelect ? "checkbox" : "radio"}
                  {name}
                  value={OTHER_LABEL}
                  checked={otherChecked}
                  disabled={!!lockedAnswer}
                  onchange={() => toggleLabel(q, OTHER_LABEL)} />
                <span class="auq-option-body">
                  <span class="auq-option-label">{OTHER_LABEL}</span>
                  <input
                    type="text"
                    class="auq-other-input"
                    placeholder="Type your own answer"
                    value={state.otherText}
                    disabled={!!lockedAnswer}
                    oninput={(e) => setOtherText(q, (e.currentTarget as HTMLInputElement).value)} />
                </span>
              </label>
            </div>

            <div class="auq-notes-row">
              {#if !lockedAnswer}
                <button
                  type="button"
                  class="auq-notes-toggle"
                  aria-expanded={notesOpen[q.question] ? "true" : "false"}
                  onclick={() => (notesOpen[q.question] = !notesOpen[q.question])}>
                  {notesOpen[q.question] ? "−" : "+"} Add note
                </button>
              {/if}
              {#if notesOpen[q.question] || (lockedAnswer && state.notes.length > 0)}
                {#if lockedAnswer}
                  <p class="auq-notes-locked">{state.notes}</p>
                {:else}
                  <textarea
                    class="auq-notes-input"
                    rows="2"
                    placeholder="Optional context for this answer"
                    value={state.notes}
                    oninput={(e) => setNotes(q, (e.currentTarget as HTMLTextAreaElement).value)}>
                  </textarea>
                {/if}
              {/if}
            </div>
          </fieldset>
        </li>
      {/each}
    </ul>

    {#if lockedAnswer}
      <div class="auq-footer auq-footer-locked">
        <Check size={14} aria-hidden="true" />
        <span>Submitted</span>
      </div>
    {:else}
      <div class="auq-footer">
        <button
          type="button"
          class="auq-submit"
          disabled={!canSubmit}
          onclick={submit}>
          <Send size={14} aria-hidden="true" />
          Submit answers
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
    justify-content: flex-end;
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
</style>
