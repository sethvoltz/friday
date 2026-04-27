<div class="empty-state">
  <p class="empty-icon">🌱</p>
  <p>Select a proposal from the sidebar to view its details, signals, and apply or reject it.</p>
  <p class="empty-hint">Proposals come from <code>scheduled-meta-daily</code>, which scans Friday's logs at 4am.</p>
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-tertiary);
    gap: 0.5rem;
    text-align: center;
    padding: 1rem;
  }
  .empty-icon { font-size: 2.5rem; margin: 0; }
  .empty-state p { margin: 0; font-size: 0.85rem; max-width: 32rem; }
  .empty-hint { color: var(--text-tertiary); font-size: 0.75rem; }
  code {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    padding: 0.05rem 0.25rem;
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
  }
</style>
