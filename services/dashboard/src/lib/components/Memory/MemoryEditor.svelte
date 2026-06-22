<script lang="ts">
  // FRI-172 (AC15): the ONE editor surface reused for BOTH create (blank form)
  // and edit (prefilled). It is presentation-only — it emits the parsed
  // {title, content, tags} payload via callback props and never touches Zero or
  // computes slugs. The parent (MemoryList for create, MemoryCard for edit) owns
  // the mutator call + slug (contract §5), so the editor stays DOM-pure and the
  // create/edit mutator semantics live at a single call site.
  import type { MemoryView } from "./facet-filter";

  interface Props {
    /** "create" → blank form, submit calls oncreate; "edit" → prefilled, submit calls onsave. */
    mode: "create" | "edit";
    /** Edit-mode seed (ignored in create mode). */
    entry?: MemoryView;
    /** Disable inputs while a parent op is in flight. */
    busy?: boolean;
    /** create-mode submit. tags already split+trimmed+filtered. */
    oncreate?: (data: { title: string; content: string; tags: string[] }) => void;
    /** edit-mode submit. */
    onsave?: (data: { title: string; content: string; tags: string[] }) => void;
    /** Cancel / dismiss. */
    oncancel?: () => void;
  }

  let { mode, entry, busy = false, oncreate, onsave, oncancel }: Props = $props();

  // Edit mode seeds from `entry`; create mode starts blank. Same field handling
  // as the current pages: title/content plain strings, tags a comma-joined
  // string parsed on submit (memory/+page.svelte createMemory; [id]/+page.svelte
  // startEdit/save).
  // svelte-ignore state_referenced_locally
  let title = $state(mode === "edit" && entry ? entry.title : "");
  // svelte-ignore state_referenced_locally
  let tagsText = $state(mode === "edit" && entry ? entry.tags.join(", ") : "");
  // svelte-ignore state_referenced_locally
  let content = $state(mode === "edit" && entry ? entry.content : "");

  const canSubmit = $derived(
    !busy && title.trim().length > 0 && content.trim().length > 0,
  );

  function handleSubmit(e: Event) {
    e.preventDefault();
    if (!canSubmit) return;
    // Current tag-parse idiom: split on comma, trim, drop empties.
    const tags = tagsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const data = { title: title.trim(), content, tags };
    if (mode === "create") oncreate?.(data);
    else onsave?.(data);
  }
</script>

<form class="memory-editor" onsubmit={handleSubmit}>
  <label class="field">
    <span class="row-label">Title</span>
    <input
      class="input"
      bind:value={title}
      disabled={busy}
      placeholder="Short, memorable title"
      required />
  </label>
  <label class="field">
    <span class="row-label">Tags (comma-separated, optional)</span>
    <input
      class="input"
      bind:value={tagsText}
      disabled={busy}
      placeholder="ops, runbook" />
  </label>
  <label class="field">
    <span class="row-label">Content (markdown)</span>
    <textarea
      class="textarea"
      rows="10"
      bind:value={content}
      disabled={busy}></textarea>
  </label>
  <div class="actions">
    <button
      type="submit"
      class="ghost primary"
      disabled={!canSubmit}>
      {#if mode === "create"}
        {busy ? "Creating…" : "Create memory"}
      {:else}
        {busy ? "Saving…" : "Save"}
      {/if}
    </button>
    <button
      type="button"
      class="ghost"
      onclick={() => oncancel?.()}
      disabled={busy}>
      Cancel
    </button>
  </div>
</form>

<style>
  /* Field markup reuses the .field / .row-label / .input / .textarea idiom from
     the current memory pages so the editor renders native. */
  .memory-editor {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .row-label {
    color: var(--text-tertiary);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .input,
  .textarea {
    padding: 0.55rem 0.65rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.9rem;
    font-family: inherit;
    width: 100%;
  }
  .textarea {
    font-family: var(--font-mono);
    resize: vertical;
    min-height: 200px;
  }
  .input:disabled,
  .textarea:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  button.primary {
    color: var(--accent-primary);
    border-color: var(--accent-primary);
  }
  /* iOS zoom guard — keep the 16px floor from the current pages. */
  @media (max-width: 1023px) {
    .input,
    .textarea {
      font-size: 16px;
    }
  }
</style>
