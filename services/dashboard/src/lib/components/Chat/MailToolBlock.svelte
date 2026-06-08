<script lang="ts">
  import { Mail } from "lucide-svelte";
  import { synthesizeHeadline } from "./tool-headlines";
  import { badgeClass, statusLabel } from "./tool-status";
  import CollapsibleSection from "./CollapsibleSection.svelte";

  // Purpose-built renderer for the four friday-mail tool CALLS
  // (mail_send / mail_inbox / mail_read / mail_close), registered in
  // tool-renderers.ts under their bare MCP short names (FRI-135).
  //
  // It supersedes the generic ToolBlock's raw-JSON Input/Output rendering
  // for those four tools with a glanceable message preview, reusing
  // MailBlock's visual vocabulary (meta-dl + body-pre + priority tint) for
  // consistency with INCOMING mail. It works entirely from the block data
  // the dashboard already holds — `input` (the parsed tool-use object) and
  // `output` (the tool-result string) — and never fetches the mail table.
  //
  // Accepts ALL SIX ToolRendererProps so the six-prop spread at the
  // dispatch site (ChatMessages.svelte) neither drops data nor warns under
  // svelte-check; `friendlyName` / `inputPartialJson` are intentionally
  // unused (the headline is computed from `toolName` + `input`).
  // The six-prop ToolRendererProps contract from FRI-130 — declared in
  // full here so the six-prop spread at the dispatch site
  // (ChatMessages.svelte) neither drops data nor warns under svelte-check.
  // `friendlyName` / `inputPartialJson` are accepted but intentionally
  // unused: the headline is computed from `toolName` + `input`.
  interface Props {
    toolName: string;
    friendlyName?: string;
    status: "running" | "done" | "error" | "aborted";
    input?: unknown;
    inputPartialJson?: string;
    output?: string;
    toolId?: string;
  }
  let { toolName, status, input, output }: Props = $props();

  // The MailRow shape the inbox/read tools serialize into `output`
  // (packages/shared/src/services/mail.ts). `subject`/`threadId` are
  // nullable — the summary must tolerate `null` (render nothing, never the
  // literal string "null").
  interface MailRow {
    id: number;
    fromAgent: string;
    toAgent: string;
    type: string;
    delivery: string;
    subject: string | null;
    threadId: string | null;
    body: string;
    meta: Record<string, unknown> | null;
    ts: number;
    readAt: number | null;
    closedAt: number | null;
    priority: string;
  }

  // The MCP short segment (mail_send | mail_inbox | mail_read | mail_close).
  // Mirrors FRI-130's resolver capture so an unknown short falls back to a
  // generic mail header rather than crashing.
  const MCP_TOOL_RE = /^mcp__[^_]+__(.+)$/;
  let short = $derived(MCP_TOOL_RE.exec(toolName)?.[1] ?? toolName);

  // Per-tool default headline for when `synthesizeHeadline` returns
  // undefined — i.e. mid-stream before `input` lands (status running).
  // Mirrors synthesizeHeadline's own no-arg mail strings (tool-headlines.ts).
  function defaultHeadline(s: string): string {
    if (s === "mail_send") return "Sending mail";
    if (s === "mail_inbox") return "Checking mail inbox";
    if (s === "mail_read") return "Reading mail";
    if (s === "mail_close") return "Closing mail";
    return "Mail";
  }
  let headline = $derived(synthesizeHeadline(toolName, input) ?? defaultHeadline(short));

  function asObj(v: unknown): Record<string, unknown> | undefined {
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return undefined;
  }
  function str(v: unknown): string | undefined {
    return typeof v === "string" && v.length > 0 ? v : undefined;
  }

  // --- mail_send: read the message fields off `input` (the parsed
  // tool-use object) — never the raw send output, which is only the id. ---
  let sendInput = $derived(asObj(input));
  let sendTo = $derived(str(sendInput?.to));
  let sendSubject = $derived(str(sendInput?.subject));
  let sendType = $derived(str(sendInput?.type) ?? "message");
  let sendPriority = $derived(str(sendInput?.priority) ?? "normal");
  let sendBody = $derived(str(sendInput?.body) ?? "");
  // Surface the sent id from the `mail sent (id=N)` output, when present.
  let sentId = $derived(output ? (/\(id=(\d+)\)/.exec(output)?.[1] ?? null) : null);

  // --- mail_read / mail_inbox: parse `output` (a serialized MailRow or
  // MailRow[]). On parse failure fall back to the raw output text. ---
  function parseOutput<T>(): { ok: true; value: T } | { ok: false } {
    if (typeof output !== "string" || output.length === 0) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(output) as T };
    } catch {
      return { ok: false };
    }
  }

  let readParsed = $derived.by(() => parseOutput<MailRow>());
  let readRow = $derived(readParsed.ok ? readParsed.value : undefined);

  let inboxParsed = $derived.by(() => parseOutput<MailRow[]>());
  let inboxRows = $derived(
    inboxParsed.ok && Array.isArray(inboxParsed.value) ? inboxParsed.value : undefined,
  );

  // --- mail_close: the closed id (input.id, or parsed from `mail N closed`). ---
  let closeId = $derived(
    (typeof sendInput?.id === "number" ? String(sendInput.id) : str(sendInput?.id)) ??
      (output ? (/mail (\d+) closed/.exec(output)?.[1] ?? null) : null),
  );

  function priorityClass(p: string | null | undefined): string {
    return p === "critical" ? "priority-critical" : "";
  }
</script>

<div class="mail-tool-block">
  <div class="mail-tool-head">
    <span class="mail-icon" aria-hidden="true"><Mail size={16} /></span>
    <span class="mail-tool-headline">{headline}</span>
    <span class="badge {badgeClass(status)}">{statusLabel(status)}</span>
  </div>

  {#if short === "mail_send"}
    {#if sendInput}
      <div class="mail-tool-body">
        <dl class="mail-meta">
          {#if sendTo}
            <dt>to</dt>
            <dd><code>{sendTo}</code></dd>
          {/if}
          {#if sendSubject}
            <dt>subject</dt>
            <dd>{sendSubject}</dd>
          {/if}
          <dt>type</dt>
          <dd><code>{sendType}</code></dd>
          <dt>priority</dt>
          <dd><code class={priorityClass(sendPriority)}>{sendPriority}</code></dd>
          {#if sentId}
            <dt>sent</dt>
            <dd><code>id={sentId}</code></dd>
          {/if}
        </dl>
        {#if sendBody}
          <div class="mail-body-label">body</div>
          <CollapsibleSection collapsedMaxHeight={200}>
            <pre class="mail-pre">{sendBody}</pre>
          </CollapsibleSection>
        {/if}
        {#if sentId}
          <div class="open-bar">
            <a href="/mail/{sentId}" class="open-in-mail">Open in Mail</a>
          </div>
        {/if}
      </div>
    {/if}
  {:else if short === "mail_read"}
    {#if readRow}
      <div class="mail-tool-body">
        <dl class="mail-meta">
          <dt>id</dt>
          <dd><code>{readRow.id}</code></dd>
          <dt>from</dt>
          <dd><code>{readRow.fromAgent}</code></dd>
          {#if readRow.subject}
            <dt>subject</dt>
            <dd>{readRow.subject}</dd>
          {/if}
          <dt>type</dt>
          <dd><code>{readRow.type}</code></dd>
          <dt>priority</dt>
          <dd><code class={priorityClass(readRow.priority)}>{readRow.priority}</code></dd>
        </dl>
        {#if readRow.body}
          <div class="mail-body-label">body</div>
          <CollapsibleSection collapsedMaxHeight={200}>
            <pre class="mail-pre">{readRow.body}</pre>
          </CollapsibleSection>
        {/if}
        <div class="open-bar">
          <a href="/mail/{readRow.id}" class="open-in-mail">Open in Mail</a>
        </div>
      </div>
    {:else if output}
      <!-- Parse-failure fallback: show the raw output text. -->
      <div class="mail-tool-body">
        <CollapsibleSection collapsedMaxHeight={200}>
          <pre class="mail-pre">{output}</pre>
        </CollapsibleSection>
      </div>
    {/if}
  {:else if short === "mail_inbox"}
    {#if inboxRows}
      <div class="mail-tool-body">
        {#if inboxRows.length === 0}
          <div class="mail-empty">Inbox empty</div>
        {:else}
          <div class="mail-count">{inboxRows.length} pending</div>
          <ul class="mail-inbox-list">
            {#each inboxRows as row (row.id)}
              <li class="mail-inbox-row">
                <code class="mail-inbox-from">{row.fromAgent}</code>
                <span class="mail-inbox-subject">{row.subject ?? "(no subject)"}</span>
                <code class="mail-inbox-priority {priorityClass(row.priority)}">{row.priority}</code>
              </li>
            {/each}
          </ul>
          <div class="open-bar">
            <a href="/mail" class="open-in-mail">Browse in Mail</a>
          </div>
        {/if}
      </div>
    {:else if output}
      <div class="mail-tool-body">
        <CollapsibleSection collapsedMaxHeight={200}>
          <pre class="mail-pre">{output}</pre>
        </CollapsibleSection>
      </div>
    {/if}
  {:else if short === "mail_close"}
    {#if closeId}
      <div class="mail-tool-body">
        <div class="mail-close-line">mail #{closeId} closed</div>
        <div class="open-bar">
          <a href="/mail/{closeId}" class="open-in-mail">Open in Mail</a>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .mail-tool-block {
    border-left: 2px solid var(--accent-primary);
    padding: 0.25rem 0;
    font-size: 0.85rem;
  }
  .mail-tool-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.25rem 0.75rem;
    text-align: left;
  }
  .mail-icon {
    display: inline-flex;
    align-items: center;
    color: var(--accent-primary);
  }
  .mail-tool-headline {
    /* Grow to push the (globally-styled) `.badge` to the right edge,
       mirroring ToolBlock's header layout. */
    flex: 1;
    color: var(--text-primary);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .mail-tool-body {
    margin: 0.4rem 0.75rem 0.25rem 1.25rem;
    padding: 0.5rem 0.75rem;
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
  }
  .mail-meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.2rem 0.75rem;
    margin: 0 0 0.6rem 0;
    font-size: 0.78rem;
  }
  .mail-meta dt {
    color: var(--text-tertiary);
    text-transform: uppercase;
    font-size: 0.65rem;
    letter-spacing: 0.06em;
    align-self: center;
  }
  .mail-meta dd {
    margin: 0;
    color: var(--text-primary);
    overflow-wrap: anywhere;
  }
  .mail-meta code {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    background: var(--bg-code);
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    color: var(--text-secondary);
  }
  /* Mirror MailBlock's critical tint. Specificity must beat `.mail-meta
     code` / `.mail-inbox-priority` (both set their own color), so qualify
     the selectors rather than relying on source order alone. */
  .mail-meta code.priority-critical,
  code.priority-critical,
  .mail-inbox-priority.priority-critical {
    color: var(--status-error);
  }
  .mail-body-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
  .mail-pre {
    margin: 0;
    padding: 0.5rem 0.6rem;
    background: var(--bg-code);
    border-radius: var(--radius-sm);
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .mail-count {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    font-weight: 600;
    margin-bottom: 0.4rem;
  }
  .mail-empty {
    color: var(--text-tertiary);
    font-size: 0.8rem;
  }
  .mail-inbox-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .mail-inbox-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.78rem;
  }
  .mail-inbox-from {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--accent-primary);
    flex-shrink: 0;
  }
  .mail-inbox-subject {
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .mail-inbox-priority {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }
  .mail-close-line {
    color: var(--text-secondary);
    font-size: 0.8rem;
  }
  .open-bar {
    margin-top: 0.5rem;
    padding-top: 0.4rem;
    border-top: 1px solid var(--border-subtle);
  }
  .open-in-mail {
    font-size: 0.72rem;
    color: var(--accent-primary);
    text-decoration: none;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    display: inline-block;
    transition: all var(--transition-fast);
  }
  .open-in-mail:hover {
    border-color: var(--accent-primary);
    background: var(--accent-glow);
  }
</style>
