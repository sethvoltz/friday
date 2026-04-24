<script lang="ts">
  let { data } = $props();

  let expandedTools = $state(new Set<string>());

  function toggleTool(id: string) {
    if (expandedTools.has(id)) {
      expandedTools.delete(id);
    } else {
      expandedTools.add(id);
    }
    expandedTools = new Set(expandedTools);
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
    <div class="header-title">
      <h2>
        💬 {data.label}
        {#if data.isFormer}
          <span class="former-badge">former</span>
        {/if}
      </h2>
      <span class="header-meta">bare session</span>
    </div>

    <div class="header-stats">
      {#if data.stats}
        <span class="stat">Turns: {data.stats.turns}</span>
        <span class="stat">Cost: {formatCost(data.stats.cost)}</span>
      {/if}
    </div>
  </header>

  {#if data.turns.length === 0}
    <div class="empty-transcript">
      <p>No transcript data available.</p>
      {#if !data.sessionId}
        <p class="hint">No session found for this channel.</p>
      {:else}
        <p class="hint">The session JSONL file may not exist yet.</p>
      {/if}
    </div>
  {:else}
    <div class="turn-list">
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
              <div class="message-content">{turn.prompt}</div>
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
              <div class="message-content">{turn.response}</div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .transcript-page { max-width: 900px; }

  .transcript-header {
    padding-bottom: 1rem;
    margin-bottom: 1rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .header-title { display: flex; align-items: baseline; gap: 0.75rem; }
  .header-title h2 { font-size: 1.2rem; font-weight: 600; color: var(--text-primary); margin: 0; }
  .header-meta { font-size: 0.8rem; color: var(--text-tertiary); }
  .former-badge {
    font-size: 0.65rem; padding: 0.15rem 0.4rem; border-radius: var(--radius-sm);
    background: var(--bg-tertiary); color: var(--text-tertiary); font-weight: 500; vertical-align: middle;
  }
  .header-stats { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: 0.5rem; }
  .stat { font-size: 0.75rem; color: var(--text-secondary); }

  .empty-transcript { text-align: center; padding: 3rem; color: var(--text-tertiary); }
  .hint { font-size: 0.8rem; margin-top: 0.5rem; }

  .turn-list { display: flex; flex-direction: column; gap: 1.5rem; }
  .turn {
    border: 1px solid var(--border-subtle); border-radius: var(--radius-md);
    padding: 1rem; background: var(--bg-card);
  }
  .turn-header {
    display: flex; align-items: center; gap: 0.75rem;
    margin-bottom: 0.75rem; font-size: 0.75rem; color: var(--text-tertiary);
  }
  .turn-number { font-weight: 600; color: var(--text-secondary); }
  .turn-tokens { margin-left: auto; font-family: var(--font-mono); font-size: 0.65rem; }

  .message { margin: 0.5rem 0; padding: 0.6rem 0.8rem; border-radius: var(--radius-sm); }
  .user-message { background: var(--accent-glow); border-left: 3px solid var(--accent-primary); }
  .assistant-message { background: var(--bg-tertiary); border-left: 3px solid var(--text-tertiary); }
  .message-role {
    font-size: 0.65rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--text-tertiary); margin-bottom: 0.3rem;
  }
  .message-content {
    font-size: 0.85rem; color: var(--text-primary);
    white-space: pre-wrap; word-break: break-word; line-height: 1.5;
  }

  .tool-calls { margin: 0.5rem 0; padding-left: 0.5rem; }
  .tool-call {
    display: flex; align-items: center; gap: 0.4rem;
    padding: 0.3rem 0.5rem; font-size: 0.75rem; font-family: var(--font-mono);
    color: var(--text-secondary); background: transparent; border: none;
    cursor: pointer; border-radius: var(--radius-sm); width: 100%; text-align: left;
  }
  .tool-call:hover { background: var(--bg-tertiary); }
  .tool-call.tool-error { color: var(--status-error); }
  .tool-arrow { font-size: 0.6rem; width: 0.8rem; }
  .tool-name { font-weight: 500; }
  .tool-error-badge {
    font-size: 0.6rem; padding: 0.1rem 0.3rem; border-radius: var(--radius-sm);
    background: var(--status-error-bg); color: var(--status-error); font-weight: 600;
  }
  .tool-detail {
    margin: 0.25rem 0 0.5rem 1.3rem; padding: 0.5rem;
    font-size: 0.7rem; background: var(--bg-code); border-radius: var(--radius-sm);
    overflow-x: auto; max-height: 200px; color: var(--text-secondary);
  }
</style>
