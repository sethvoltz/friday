<script lang="ts">
  import { enhance } from '$app/forms';
  import type { Proposal } from '@friday/evolve';
  import Markdown from '$lib/Markdown.svelte';

  let { data, form } = $props();
  const proposal: Proposal = $derived(data.proposal);

  let showRejectReason = $state(false);

  const isTerminal = $derived(['applied', 'rejected', 'superseded'].includes(proposal.status));

  function fmtDate(d: string): string {
    return new Date(d).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
</script>

<div class="proposal-detail">
  <header class="detail-header">
    <div class="title-row">
      <span class="status-badge status-{proposal.status}">{proposal.status}</span>
      <h2>{proposal.title}</h2>
      <span class="score-pill">score {proposal.score}</span>
    </div>
    <div class="meta-row">
      <span><strong>type</strong> {proposal.type}</span>
      <span class="sep">·</span>
      <span><strong>blast</strong> {proposal.blastRadius}</span>
      <span class="sep">·</span>
      <span><strong>by</strong> {proposal.createdBy}</span>
      <span class="sep">·</span>
      <span>{fmtDate(proposal.createdAt)}</span>
      {#if proposal.appliedAt}
        <span class="sep">·</span>
        <span><strong>applied</strong> {fmtDate(proposal.appliedAt)} by {proposal.appliedBy}</span>
      {/if}
    </div>
    {#if proposal.appliesTo.length > 0}
      <div class="targets">
        {#each proposal.appliesTo as target}
          <span class="target">{target}</span>
        {/each}
      </div>
    {/if}
  </header>

  {#if form?.message}
    <div class="flash" class:error={!form.ok}>
      {form.message}
      {#if form.restartHint}
        <div class="flash-hint">{form.restartHint}</div>
      {/if}
    </div>
  {/if}

  <div class="detail-body">
    <section>
      <h3>Signals</h3>
      {#if proposal.signals.length === 0}
        <p class="empty">(none)</p>
      {:else}
        <ul class="signal-list">
          {#each proposal.signals as s}
            <li>
              <code>{s.key}</code>
              <span class="signal-meta">
                {s.severity} · {s.count}x
                {#if s.agent}· agent={s.agent}{/if}
              </span>
              <div class="signal-window">
                {fmtDate(s.firstSeenAt)} → {fmtDate(s.lastSeenAt)}
              </div>
              {#if s.evidencePointers.length > 0}
                <details>
                  <summary>{s.evidencePointers.length} evidence pointer(s)</summary>
                  <ul class="evidence">
                    {#each s.evidencePointers as ev}
                      <li>
                        <code>{ev.kind}</code> {ev.path}{ev.line ? `:${ev.line}` : ''}
                      </li>
                    {/each}
                  </ul>
                </details>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h3>Proposed change</h3>
      <div class="proposed-change"><Markdown source={proposal.proposedChange} /></div>
    </section>
  </div>

  {#if !isTerminal}
    <div class="action-bar">
      <form method="POST" action="?/approve" use:enhance>
        <button type="submit" class="btn btn-primary">Approve & apply</button>
      </form>
      {#if !showRejectReason}
        <button class="btn btn-ghost" onclick={() => (showRejectReason = true)}>Reject…</button>
      {:else}
        <form method="POST" action="?/reject" use:enhance class="reject-form">
          <input type="text" name="reason" placeholder="Reason (optional)" />
          <button type="submit" class="btn btn-danger">Confirm reject</button>
          <button type="button" class="btn btn-ghost" onclick={() => (showRejectReason = false)}>Cancel</button>
        </form>
      {/if}
    </div>
  {/if}
</div>

<style>
  .proposal-detail {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .detail-header {
    padding: 1rem 0 1rem;
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.5rem;
    flex-wrap: wrap;
  }

  .title-row h2 {
    margin: 0;
    font-size: 1.2rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .status-badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-radius: 99px;
    background: var(--bg-tertiary);
    color: var(--text-tertiary);
  }
  .status-badge.status-critical { background: #ef4444; color: white; }
  .status-badge.status-open { background: var(--accent-glow); color: var(--accent-primary); }
  .status-badge.status-approved { background: #facc15; color: #422006; }
  .status-badge.status-applied { background: #22c55e; color: white; }
  .status-badge.status-rejected { background: var(--bg-tertiary); color: var(--text-tertiary); }
  .status-badge.status-superseded { background: var(--bg-tertiary); color: var(--text-tertiary); }

  .score-pill {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--text-tertiary);
    padding: 0.1rem 0.4rem;
    background: var(--bg-tertiary);
    border-radius: 99px;
  }

  .meta-row {
    font-size: 0.8rem;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .meta-row strong {
    color: var(--text-tertiary);
    font-weight: 600;
    font-size: 0.7rem;
    text-transform: uppercase;
    margin-right: 0.15rem;
  }

  .sep { color: var(--text-tertiary); }

  .targets {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.6rem;
    flex-wrap: wrap;
  }
  .target {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
  }

  .flash {
    margin-top: 0.75rem;
    padding: 0.5rem 0.75rem;
    background: var(--accent-glow);
    color: var(--accent-primary);
    border-radius: var(--radius-sm);
    font-size: 0.8rem;
  }
  .flash.error {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }
  .flash-hint {
    margin-top: 0.25rem;
    font-size: 0.7rem;
    opacity: 0.8;
  }

  .detail-body {
    flex: 1;
    overflow-y: auto;
    padding: 1.25rem 0;
  }

  section { margin-bottom: 1.5rem; }

  section h3 {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 0.6rem;
  }

  .empty { color: var(--text-tertiary); font-size: 0.8rem; margin: 0; }

  .signal-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .signal-list li {
    padding: 0.5rem 0.75rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.8rem;
  }

  .signal-list code {
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text-primary);
  }

  .signal-meta {
    margin-left: 0.5rem;
    color: var(--text-tertiary);
    font-size: 0.7rem;
  }

  .signal-window {
    color: var(--text-tertiary);
    font-size: 0.7rem;
    margin-top: 0.2rem;
  }

  .signal-list details {
    margin-top: 0.4rem;
    font-size: 0.7rem;
  }

  .evidence {
    list-style: none;
    padding: 0.4rem 0 0 0.5rem;
    margin: 0;
    color: var(--text-secondary);
  }

  .proposed-change {
    max-width: 65ch;
  }

  .action-bar {
    flex-shrink: 0;
    padding: 0.75rem 0;
    border-top: 1px solid var(--border-subtle);
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .reject-form {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex: 1;
  }

  .reject-form input {
    flex: 1;
    padding: 0.4rem 0.6rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.8rem;
  }

  .btn {
    padding: 0.45rem 0.9rem;
    font-size: 0.8rem;
    font-weight: 500;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .btn-primary {
    background: var(--accent-primary);
    color: var(--text-inverse);
  }
  .btn-primary:hover { opacity: 0.9; }

  .btn-ghost {
    background: transparent;
    color: var(--text-secondary);
    border-color: var(--border-subtle);
  }
  .btn-ghost:hover { background: var(--bg-tertiary); color: var(--text-primary); }

  .btn-danger {
    background: rgba(239, 68, 68, 0.1);
    color: #ef4444;
    border-color: rgba(239, 68, 68, 0.4);
  }
  .btn-danger:hover { background: rgba(239, 68, 68, 0.2); }
</style>
