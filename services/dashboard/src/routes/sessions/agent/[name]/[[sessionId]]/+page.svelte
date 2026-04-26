<script lang="ts">
  import { getStreamingText, getDataVersion, clearStreaming } from '$lib/events.svelte';
  import Markdown from '$lib/Markdown.svelte';
  import { invalidateAll, goto } from '$app/navigation';

  let { data } = $props();

  const isScheduled = $derived(data.entry?.type === 'scheduled');
  const runs = $derived(data.scheduledRuns ?? []);
  const currentRunIdx = $derived(
    isScheduled && data.sessionId
      ? runs.findIndex((r) => r.sessionId === data.sessionId)
      : -1
  );

  function runUrl(sessionId: string, isCurrent: boolean): string {
    return isCurrent
      ? `/sessions/agent/${data.agentName}`
      : `/sessions/agent/${data.agentName}/${sessionId}`;
  }

  function runLabel(run: { firstAt: string; lastAt: string; isCurrent: boolean }, idx: number, total: number): string {
    const num = total - idx; // run #N where higher = newer
    const date = run.firstAt
      ? new Date(run.firstAt).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'no data';
    const tag = run.isCurrent ? ' (current)' : '';
    return `Run #${num} · ${date}${tag}`;
  }

  function onRunSelect(e: Event) {
    const target = e.target as HTMLSelectElement;
    const sid = target.value;
    const run = runs.find((r) => r.sessionId === sid);
    if (run) goto(runUrl(run.sessionId, run.isCurrent));
  }

  function gotoPrev() {
    // "Previous" = older run (higher index in the list)
    if (currentRunIdx < 0 || currentRunIdx >= runs.length - 1) return;
    const r = runs[currentRunIdx + 1];
    goto(runUrl(r.sessionId, r.isCurrent));
  }

  function gotoNext() {
    // "Next" = newer run (lower index)
    if (currentRunIdx <= 0) return;
    const r = runs[currentRunIdx - 1];
    goto(runUrl(r.sessionId, r.isCurrent));
  }

  let expandedTools = $state(new Set<string>());

  // Re-fetch transcript when turns complete
  let lastVersion = $state(getDataVersion());
  $effect(() => {
    const v = getDataVersion();
    if (v !== lastVersion) {
      lastVersion = v;
      invalidateAll();
      clearStreaming();
    }
  });

  // Clear streaming on navigation
  $effect(() => {
    data.agentName;
    clearStreaming();
  });

  const streamText = $derived(getStreamingText(data.agentName));

  // Scroll tracking
  let turnListEl = $state<HTMLElement | null>(null);
  let showScrollTop = $state(false);
  let showScrollBottom = $state(false);
  let wasAtBottom = $state(true);

  function updateScrollButtons() {
    if (!turnListEl) return;
    const { scrollTop, scrollHeight, clientHeight } = turnListEl;
    showScrollTop = scrollTop > 50;
    showScrollBottom = scrollTop + clientHeight < scrollHeight - 50;
    wasAtBottom = scrollTop + clientHeight >= scrollHeight - 50;
  }

  function scrollToTop() {
    turnListEl?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function scrollToBottom() {
    turnListEl?.scrollTo({ top: turnListEl.scrollHeight, behavior: 'smooth' });
  }

  // Auto-scroll to bottom when new content arrives and already at bottom
  $effect(() => {
    // Track dependencies
    streamText;
    data.turns;
    if (wasAtBottom && turnListEl) {
      turnListEl.scrollTo({ top: turnListEl.scrollHeight });
    }
  });

  function toggleTool(id: string) {
    if (expandedTools.has(id)) {
      expandedTools.delete(id);
    } else {
      expandedTools.add(id);
    }
    expandedTools = new Set(expandedTools);
  }

  function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max) + '…';
  }

  function formatTime(ts: string): string {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toLocaleDateString() === now.toLocaleDateString();
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    if (isToday) return time;
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${date} ${time}`;
  }

  function formatCost(cost: number): string {
    return `$${cost.toFixed(4)}`;
  }
</script>

<div class="transcript-page">
  <header class="transcript-header">
    <div class="header-row">
      <div class="header-title">
        <h2>
          {#if data.entry}
            {#if data.entry.type === 'orchestrator'}👑
            {:else if data.entry.type === 'builder'}🔨
            {:else if data.entry.type === 'scheduled'}🕐
            {:else}⚡
            {/if}
          {/if}
          {data.agentName}
          {#if data.isFormer && !isScheduled}
            <span class="former-badge">former</span>
          {/if}
        </h2>
        {#if data.entry}
          <span class="header-meta">{data.entry.type} · {data.entry.status}</span>
        {/if}
      </div>

      {#if isScheduled && runs.length > 0}
        <div class="run-nav">
          <button
            class="run-btn"
            onclick={gotoPrev}
            disabled={currentRunIdx < 0 || currentRunIdx >= runs.length - 1}
            title="Older run"
          >← Prev</button>
          <select
            class="run-select"
            value={data.sessionId ?? ''}
            onchange={onRunSelect}
          >
            {#each runs as run, i}
              <option value={run.sessionId}>{runLabel(run, i, runs.length)}</option>
            {/each}
          </select>
          <button
            class="run-btn"
            onclick={gotoNext}
            disabled={currentRunIdx <= 0}
            title="Newer run"
          >Next →</button>
        </div>
      {/if}
    </div>

    <div class="header-stats">
      {#if data.stats}
        <span class="stat">Turns: {data.stats.turns}</span>
        <span class="stat">Cost: {formatCost(data.stats.cost)}</span>
      {/if}
      {#if data.entry && 'parent' in data.entry}
        <span class="stat">Parent: {data.entry.parent}</span>
      {/if}
      {#if data.entry && 'workspace' in data.entry}
        <span class="stat mono">CWD: {data.entry.workspace}</span>
      {:else if data.entry && 'cwd' in data.entry}
        <span class="stat mono">CWD: {data.entry.cwd}</span>
      {/if}
    </div>
  </header>

  {#if data.turns.length === 0}
    <div class="empty-transcript">
      <p>No transcript data available.</p>
      {#if !data.entry}
        <p class="hint">Agent "{data.agentName}" not found in registry.</p>
      {:else if !data.sessionId}
        <p class="hint">No session ID available for this agent.</p>
      {:else}
        <p class="hint">The session JSONL file may not exist yet.</p>
      {/if}
    </div>
  {:else}
    <div class="turn-list-wrapper">
      <div class="turn-list" bind:this={turnListEl} onscroll={updateScrollButtons}>
        {#each data.turns as turn}
          <div class="turn">
            <div class="turn-header">
              <span class="turn-number">Turn {turn.index + 1}</span>
              {#if turn.timestamp}
                <span class="turn-time">{formatTime(turn.timestamp)}</span>
              {/if}
              {#if turn.usage?.input_tokens || turn.usage?.output_tokens}
                <span class="turn-tokens">
                  {turn.usage.input_tokens ?? 0} in / {turn.usage.output_tokens ?? 0} out
                </span>
              {/if}
            </div>

            {#if turn.prompt}
              <div class="message user-message">
                <div class="message-role">User</div>
                <div class="message-content"><Markdown source={turn.prompt} /></div>
              </div>
            {/if}

            {#if turn.toolCalls.length > 0}
              <div class="tool-calls">
                {#each turn.toolCalls as tc}
                  <button
                    class="tool-call"
                    class:tool-error={tc.isError}
                    onclick={() => toggleTool(tc.id)}
                  >
                    <span class="tool-arrow">{expandedTools.has(tc.id) ? '▼' : '▶'}</span>
                    <span class="tool-name">{tc.name}</span>
                    {#if tc.isError}
                      <span class="tool-error-badge">ERROR</span>
                    {/if}
                  </button>
                  {#if expandedTools.has(tc.id)}
                    <pre class="tool-detail">{JSON.stringify(tc.input, null, 2)}</pre>
                  {/if}
                {/each}
              </div>
            {/if}

            {#if turn.response}
              <div class="message assistant-message">
                <div class="message-role">Assistant</div>
                <div class="message-content"><Markdown source={turn.response} /></div>
              </div>
            {/if}
          </div>
        {/each}

        {#if streamText}
          <div class="turn streaming-turn">
            <div class="turn-header">
              <span class="turn-number">Turn {data.turns.length + 1}</span>
              <span class="turn-time streaming-label">streaming...</span>
            </div>
            <div class="message assistant-message streaming-message">
              <div class="message-role">Assistant</div>
              <div class="message-content">{streamText}</div>
            </div>
          </div>
        {/if}
      </div>

      {#if showScrollTop}
        <button class="scroll-btn scroll-top" onclick={scrollToTop} title="Scroll to top">↑</button>
      {/if}
      {#if showScrollBottom}
        <button class="scroll-btn scroll-bottom" onclick={scrollToBottom} title="Scroll to bottom">↓</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .transcript-page {
    max-width: 900px;
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .transcript-header {
    padding-bottom: 1rem;
    margin-bottom: 1rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }

  .header-title {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }

  .run-nav {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .run-btn {
    padding: 0.3rem 0.6rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .run-btn:hover:not(:disabled) {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border-color: var(--border-primary);
  }
  .run-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .run-select {
    padding: 0.3rem 1.6rem 0.3rem 0.6rem;
    font-size: 0.75rem;
    font-family: inherit;
    color: var(--text-secondary);
    background-color: var(--bg-card);
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' d='M1 1l4 4 4-4'/></svg>");
    background-repeat: no-repeat;
    background-position: right 0.5rem center;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    cursor: pointer;
    min-width: 14rem;
    appearance: none;
    -webkit-appearance: none;
    transition: all var(--transition-fast);
  }
  .run-select:hover {
    background-color: var(--bg-tertiary);
    color: var(--text-primary);
    border-color: var(--border-primary);
  }

  .header-title h2 {
    font-size: 1.2rem;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .header-meta {
    font-size: 0.8rem;
    color: var(--text-tertiary);
  }

  .former-badge {
    font-size: 0.65rem;
    padding: 0.15rem 0.4rem;
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    color: var(--text-tertiary);
    font-weight: 500;
    vertical-align: middle;
  }

  .header-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-top: 0.5rem;
  }

  .stat {
    font-size: 0.75rem;
    color: var(--text-secondary);
  }
  .stat.mono {
    font-family: var(--font-mono);
    font-size: 0.7rem;
  }

  .empty-transcript {
    text-align: center;
    padding: 3rem;
    color: var(--text-tertiary);
  }
  .hint { font-size: 0.8rem; margin-top: 0.5rem; }

  .turn-list-wrapper {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  .turn-list {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    height: 100%;
    overflow-y: auto;
  }

  .scroll-btn {
    position: absolute;
    right: 1rem;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    border: 1px solid var(--border-primary);
    background: var(--bg-card);
    color: var(--text-secondary);
    font-size: 0.9rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: var(--shadow-sm);
    transition: all var(--transition-fast);
    z-index: 5;
  }
  .scroll-btn:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }
  .scroll-top { top: 0.5rem; }
  .scroll-bottom { bottom: 0.5rem; }

  .turn {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 1rem;
    background: var(--bg-card);
  }

  .turn-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
    font-size: 0.75rem;
    color: var(--text-tertiary);
  }

  .turn-number {
    font-weight: 600;
    color: var(--text-secondary);
  }

  .turn-tokens {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 0.65rem;
  }

  .message {
    margin: 0.5rem 0;
    padding: 0.6rem 0.8rem;
    border-radius: var(--radius-sm);
  }

  .user-message {
    background: var(--accent-glow);
    border-left: 3px solid var(--accent-primary);
  }

  .assistant-message {
    background: var(--bg-tertiary);
    border-left: 3px solid var(--text-tertiary);
  }

  .message-role {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
    margin-bottom: 0.3rem;
  }

  .message-content {
    font-size: 0.85rem;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }

  .tool-calls {
    margin: 0.5rem 0;
    padding-left: 0.5rem;
  }

  .tool-call {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.5rem;
    font-size: 0.75rem;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    background: transparent;
    border: none;
    cursor: pointer;
    border-radius: var(--radius-sm);
    width: 100%;
    text-align: left;
  }
  .tool-call:hover { background: var(--bg-tertiary); }
  .tool-call.tool-error { color: var(--status-error); }

  .tool-arrow { font-size: 0.6rem; width: 0.8rem; }
  .tool-name { font-weight: 500; }

  .tool-error-badge {
    font-size: 0.6rem;
    padding: 0.1rem 0.3rem;
    border-radius: var(--radius-sm);
    background: var(--status-error-bg);
    color: var(--status-error);
    font-weight: 600;
  }

  .tool-detail {
    margin: 0.25rem 0 0.5rem 1.3rem;
    padding: 0.5rem;
    font-size: 0.7rem;
    background: var(--bg-code);
    border-radius: var(--radius-sm);
    overflow-x: auto;
    max-height: 200px;
    color: var(--text-secondary);
  }

  .streaming-turn {
    border-color: var(--accent-primary);
    border-style: dashed;
    opacity: 0.8;
  }
  .streaming-label {
    color: var(--accent-primary);
    font-style: italic;
  }
  .streaming-message {
    opacity: 0.7;
    font-style: italic;
  }
</style>
