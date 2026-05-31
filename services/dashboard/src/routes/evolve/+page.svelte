<script lang="ts">
  import type { PageData } from "./$types";
  import type {
    BlastRadius,
    Proposal,
    ProposalStatus,
    ProposalType,
    Signal,
  } from "@friday/evolve";
  import { invalidateAll } from "$app/navigation";
  import { confirmDialog } from "$lib/components/ConfirmDialog/store.svelte";
  import Toggle from "$lib/components/Toggle/Toggle.svelte";
  import { KEYS, loadJSON, saveJSON } from "$lib/stores/persistent";
  import {
    useZero,
    zeroSync,
    type ZeroEvolveProposalRow,
  } from "$lib/stores/zero.svelte";
  import { countActionable, filterProposals } from "./filter.js";

  let { data }: { data: PageData } = $props();

  // Item #54: reactive read from the Zero `evolve_proposals` slice.
  // Daemon-side projector keeps PG in sync with the filesystem
  // canonical store; the dashboard binds reactively and drops the
  // post-mutation refreshList() round-trip. SSR data seeds first
  // paint and serves as the no-Zero fallback.
  const zeroOn = useZero();
  // svelte-ignore state_referenced_locally
  let proposals = $state<Proposal[]>(data.proposals);
  $effect(() => {
    if (zeroOn && zeroSync.status === "live") {
      proposals = zeroSync.evolveProposals.map(zeroToProposal);
    }
  });
  function zeroToProposal(r: ZeroEvolveProposalRow): Proposal {
    return {
      id: r.id,
      title: r.title,
      type: r.proposal_type as ProposalType,
      status: r.status as ProposalStatus,
      clusterId: r.cluster_id,
      score: r.score,
      signals: r.signals as Signal[],
      proposedChange: r.body,
      blastRadius: r.blast_radius as BlastRadius,
      appliesTo: r.applies_to,
      createdBy: r.created_by,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      appliedAt: r.applied_at ? new Date(r.applied_at).toISOString() : null,
      appliedBy: r.applied_by,
      enrichedAt: r.enriched_at ? new Date(r.enriched_at).toISOString() : null,
      enrichedBy: r.enriched_by,
      lastEnrichError: r.last_enrich_error,
      lastEnrichFailedAt: r.last_enrich_failed_at
        ? new Date(r.last_enrich_failed_at).toISOString()
        : null,
      appliedTicketId: r.applied_ticket_id,
    };
  }

  let selected = $state<Set<string>>(new Set());
  let expanded = $state<Set<string>>(new Set());
  let busy = $state<string | null>(null);
  let toast = $state<{ msg: string; kind: "info" | "ok" | "err" } | null>(null);

  // View pref: when off (default), terminal-status proposals (applied,
  // rejected, superseded) are hidden so the list shows only actionable
  // work. Persisted to localStorage; an effect mirrors changes back.
  let showCompleted = $state<boolean>(
    loadJSON<boolean>(KEYS.evolveShowCompleted, false),
  );
  $effect(() => {
    saveJSON(KEYS.evolveShowCompleted, showCompleted);
  });
  const visibleProposals = $derived(filterProposals(proposals, showCompleted));
  const actionableCount = $derived(countActionable(proposals));

  function showToast(msg: string, kind: "info" | "ok" | "err" = "ok") {
    toast = { msg, kind };
    setTimeout(() => {
      toast = null;
    }, 4500);
  }

  function badgeClass(status: string): string {
    if (status === "applied") return "ok";
    if (status === "approved") return "ok";
    if (status === "critical") return "error";
    if (status === "rejected") return "warn";
    return "";
  }

  function toggleSelect(id: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    selected = next;
  }

  function toggleExpand(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  function allSelected(rows: Proposal[]): boolean {
    return rows.length > 0 && rows.every((p) => selected.has(p.id));
  }

  function toggleSelectAll(rows: Proposal[]) {
    if (allSelected(rows)) {
      selected = new Set();
    } else {
      selected = new Set(rows.map((p) => p.id));
    }
  }

  async function refreshList() {
    try {
      const r = await fetch("/api/evolve/proposals");
      if (!r.ok) return;
      const fresh = (await r.json()) as Proposal[];
      proposals = fresh;
    } catch {
      // Network/daemon hiccup — leave the current view as-is.
    }
  }

  async function runOp(name: string, path: string, body: unknown = {}) {
    if (busy) return null;
    busy = name;
    try {
      let r: Response;
      try {
        r = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (err) {
        // Network errored before a status came back (offline, daemon
        // down at TLS layer, etc). Without this catch the rejection
        // bubbles past the awaiter and the button just un-spinners
        // silently — user thinks nothing happened.
        showToast(
          `${name} failed: ${err instanceof Error ? err.message : String(err)}`,
          "err",
        );
        return null;
      }
      const data = (await r
        .json()
        .catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) {
        showToast(
          typeof data.detail === "string"
            ? `${name} failed: ${data.detail}`
            : `${name} failed (${r.status})`,
          "err",
        );
        return null;
      }
      return data;
    } finally {
      busy = null;
    }
  }

  async function runScan() {
    const out = await runOp("scan", "/api/evolve/scan");
    if (out) {
      const created = Number(out.created ?? 0);
      const updated = Number(out.updated ?? 0);
      const signals = Number(out.signals ?? 0);
      showToast(
        `scan: ${signals} signal${signals === 1 ? "" : "s"} → ${created} created, ${updated} updated`,
      );
      await refreshList();
    }
  }

  async function runEnrich() {
    const out = await runOp("enrich pending", "/api/evolve/enrich", {
      retryFailed: true,
    });
    if (out) {
      const enriched = Number(out.enriched ?? 0);
      const skipped = Number(out.skipped ?? 0);
      const failed = Number(out.failed ?? 0);
      showToast(
        `enriched ${enriched}, skipped ${skipped}, failed ${failed}`,
        failed > 0 ? "info" : "ok",
      );
      await refreshList();
    }
  }

  async function runCluster() {
    const out = await runOp("cluster", "/api/evolve/cluster");
    if (out) {
      showToast(
        `clusters: ${Number(out.clustersCreated ?? 0)} created, ${Number(out.clustersUpdated ?? 0)} updated, ${Number(out.proposalsAttached ?? 0)} attached`,
      );
      await refreshList();
    }
  }

  async function applyOne(p: Proposal) {
    const out = await runOp(
      `apply ${p.id}`,
      `/api/evolve/proposals/${encodeURIComponent(p.id)}/apply`,
    );
    if (out) {
      const ticket = out.ticket as { id?: string } | undefined;
      showToast(`applied → ticket ${ticket?.id ?? "?"}`);
      await refreshList();
      await invalidateAll();
    }
  }

  async function dismissOne(p: Proposal) {
    const reason = prompt(
      `Dismiss "${p.title}". Reason (optional, will be appended to the body):`,
      "",
    );
    if (reason === null) return;
    const out = await runOp(
      `dismiss ${p.id}`,
      `/api/evolve/proposals/${encodeURIComponent(p.id)}/dismiss`,
      reason ? { reason } : {},
    );
    if (out) {
      showToast(`dismissed ${p.id}`);
      await refreshList();
    }
  }

  async function bulkApply() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const confirmed = await confirmDialog({
      title: `Apply ${ids.length} proposal${ids.length === 1 ? "" : "s"}?`,
      description: "A ticket will be created for each.",
      confirmLabel: "Apply",
    });
    if (!confirmed) return;
    busy = `bulk apply (${ids.length})`;
    let ok = 0;
    let fail = 0;
    for (const id of ids) {
      try {
        const r = await fetch(
          `/api/evolve/proposals/${encodeURIComponent(id)}/apply`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          },
        );
        if (r.ok) ok++;
        else fail++;
      } catch {
        // Network error on one row shouldn't abort the whole batch.
        fail++;
      }
    }
    busy = null;
    selected = new Set();
    showToast(
      `bulk apply: ${ok} ok, ${fail} failed`,
      fail > 0 ? "info" : "ok",
    );
    await refreshList();
    await invalidateAll();
  }

  async function bulkDismiss() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const reason = prompt(
      `Dismiss ${ids.length} proposal${ids.length === 1 ? "" : "s"}. Reason (optional, applied to each):`,
      "",
    );
    if (reason === null) return;
    busy = `bulk dismiss (${ids.length})`;
    let ok = 0;
    let fail = 0;
    for (const id of ids) {
      try {
        const r = await fetch(
          `/api/evolve/proposals/${encodeURIComponent(id)}/dismiss`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(reason ? { reason } : {}),
          },
        );
        if (r.ok) ok++;
        else fail++;
      } catch {
        fail++;
      }
    }
    busy = null;
    selected = new Set();
    showToast(
      `bulk dismiss: ${ok} ok, ${fail} failed`,
      fail > 0 ? "info" : "ok",
    );
    await refreshList();
  }

  function signalSummary(p: Proposal): string {
    if (!p.signals || p.signals.length === 0) return "—";
    const grouped: Record<string, number> = {};
    for (const s of p.signals) {
      grouped[s.source] = (grouped[s.source] ?? 0) + (s.count ?? 1);
    }
    return Object.entries(grouped)
      .map(([k, v]) => `${k}×${v}`)
      .join(" · ");
  }
</script>

<header class="page-head">
  <h1>Evolve</h1>
  <p class="page-lead">
    Self-improvement proposals (scan → enrich → cluster → apply).
  </p>
</header>

<div class="card">
  <div class="card-header">
    <h2>Pipeline</h2>
  </div>
  <p class="row-value">
    Each button kicks off the corresponding pipeline stage against the daemon.
    Scan reads the rolling daemon log + usage table; enrich fires a Sonnet pass
    on pending bodies; cluster groups near-duplicate proposals.
  </p>
  <div class="actions">
    <button class="ghost" onclick={runScan} disabled={busy !== null}>
      {busy === "scan" ? "Scanning…" : "Run scan"}
    </button>
    <button class="ghost" onclick={runEnrich} disabled={busy !== null}>
      {busy === "enrich pending" ? "Enriching…" : "Enrich pending"}
    </button>
    <button class="ghost" onclick={runCluster} disabled={busy !== null}>
      {busy === "cluster" ? "Clustering…" : "Cluster"}
    </button>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <h2>Proposals</h2>
    <div class="header-controls">
      <span class="stat-detail">
        {proposals.length} total{#if !showCompleted && actionableCount !== proposals.length}
          <span class="muted"> ({actionableCount} actionable)</span>
        {/if}
      </span>
      <Toggle
        bind:checked={showCompleted}
        label="Show completed"
        title="Show applied, rejected, and superseded proposals" />
    </div>
  </div>

  {#if selected.size > 0}
    <div class="bulk-bar">
      <span>{selected.size} selected</span>
      <div class="bulk-actions">
        <button class="ghost" onclick={bulkApply} disabled={busy !== null}>
          Bulk apply
        </button>
        <button class="ghost danger" onclick={bulkDismiss} disabled={busy !== null}>
          Bulk dismiss
        </button>
        <button class="ghost" onclick={() => (selected = new Set())}>
          Clear
        </button>
      </div>
    </div>
  {/if}

  {#if proposals.length === 0}
    <p class="empty-state">
      No proposals yet. Friday's daily meta-agent runs at 04:00 and scans the daemon log,
      usage table, and transcripts for patterns worth improving. You can also
      trigger a scan on demand with the button above.
    </p>
  {:else if visibleProposals.length === 0}
    <p class="empty-state">
      All {proposals.length} proposal{proposals.length === 1 ? " is" : "s are"} in a
      terminal state. Flip "Show completed" to view them.
    </p>
  {:else}
    <div class="table-scroll-wrapper">
    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">
            <input
              type="checkbox"
              aria-label="Select all"
              checked={allSelected(visibleProposals)}
              onchange={() => toggleSelectAll(visibleProposals)} />
          </th>
          <th>Title</th>
          <th>Type</th>
          <th>Status</th>
          <th class="text-right">Score</th>
          <th>Signals</th>
          <th aria-label="Actions"></th>
        </tr>
      </thead>
      <tbody>
        {#each visibleProposals as p (p.id)}
          <tr class:expanded={expanded.has(p.id)}>
            <td class="col-check">
              <input
                type="checkbox"
                aria-label="Select {p.id}"
                checked={selected.has(p.id)}
                onchange={(e) =>
                  toggleSelect(
                    p.id,
                    (e.currentTarget as HTMLInputElement).checked,
                  )} />
            </td>
            <td>
              <button
                class="link-button"
                onclick={() => toggleExpand(p.id)}
                aria-expanded={expanded.has(p.id)}>
                <span class="caret" aria-hidden="true"
                  >{expanded.has(p.id) ? "−" : "+"}</span>
                {p.title}
              </button>
              <div class="row-meta">
                <code class="text-mono">{p.id}</code>
                <span class="blast">blast: {p.blastRadius}</span>
              </div>
            </td>
            <td><span class="badge">{p.type}</span></td>
            <td><span class="badge {badgeClass(p.status)}">{p.status}</span></td>
            <td class="text-mono text-right">{p.score}</td>
            <td class="text-mono">{signalSummary(p)}</td>
            <td class="actions-cell">
              <div class="actions-row">
                {#if p.status !== "applied" && p.status !== "rejected"}
                  <button
                    class="ghost compact"
                    onclick={() => applyOne(p)}
                    disabled={busy !== null}>
                    Apply
                  </button>
                  <button
                    class="ghost compact danger"
                    onclick={() => dismissOne(p)}
                    disabled={busy !== null}>
                    Dismiss
                  </button>
                {:else if p.status === "applied" && p.appliedTicketId}
                  <a class="link" href="/tickets/{p.appliedTicketId}"
                    >ticket {p.appliedTicketId}</a>
                {:else}
                  <span class="muted">—</span>
                {/if}
              </div>
            </td>
          </tr>
          {#if expanded.has(p.id)}
            <tr class="expand-row">
              <td colspan="7">
                <div class="expand-body">
                  <pre class="proposed-change">{p.proposedChange}</pre>
                  {#if p.signals && p.signals.length > 0}
                    <details class="signals-detail">
                      <summary>Signals ({p.signals.length})</summary>
                      <ul class="signals-list">
                        {#each p.signals as s (s.hash)}
                          <li>
                            <span class="sig-source">{s.source}</span>
                            <span class="sig-key text-mono">{s.key}</span>
                            <span class="sig-severity badge">{s.severity}</span>
                            <span class="sig-count">×{s.count}</span>
                          </li>
                        {/each}
                      </ul>
                    </details>
                  {/if}
                  <div class="expand-meta">
                    <span>created {new Date(p.createdAt).toLocaleString()}</span>
                    {#if p.enrichedAt}
                      <span
                        >enriched {new Date(p.enrichedAt).toLocaleString()}
                        {p.enrichedBy ? `by ${p.enrichedBy}` : ""}</span>
                    {:else}
                      <span class="muted">not yet enriched</span>
                    {/if}
                    {#if p.lastEnrichError}
                      <span class="err"
                        >last enrich error: {p.lastEnrichError}</span>
                    {/if}
                  </div>
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
    </div>
  {/if}
</div>

{#if toast}
  <div class="toast toast-{toast.kind}" role="status" aria-live="polite">
    {toast.msg}
  </div>
{/if}

<style>
  .row-value {
    color: var(--text-primary);
    margin: 0.5rem 0;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
    flex-wrap: wrap;
  }
  .header-controls {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .col-check {
    width: 1.5rem;
    text-align: center;
  }
  .text-right {
    text-align: right;
  }
  .text-mono {
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
  .link-button {
    background: none;
    border: none;
    padding: 0;
    color: var(--text-primary);
    font: inherit;
    cursor: pointer;
    text-align: left;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .link-button:hover {
    color: var(--accent-primary);
  }
  .caret {
    color: var(--text-tertiary);
    width: 0.8rem;
    text-align: center;
  }
  .row-meta {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    margin-top: 0.2rem;
    font-size: 0.75rem;
    color: var(--text-tertiary);
  }
  .blast {
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .actions-cell {
    text-align: right;
    white-space: nowrap;
  }
  .actions-row {
    display: inline-flex;
    gap: 0.35rem;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .ghost.compact {
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
  }
  .bulk-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 0.75rem;
    margin: 0.5rem 0;
    border: 1px solid var(--accent-primary);
    border-radius: var(--radius-sm);
    background: var(--accent-glow);
    font-size: 0.85rem;
  }
  .bulk-actions {
    display: flex;
    gap: 0.4rem;
  }
  .expand-row > td {
    padding: 0;
    background: var(--bg-secondary);
  }
  .expand-body {
    padding: 0.8rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .proposed-change {
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    padding: 0.6rem;
    background: var(--bg-code);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--text-primary);
    max-height: 380px;
    overflow: auto;
  }
  .signals-detail summary {
    cursor: pointer;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
  .signals-list {
    list-style: none;
    padding: 0.4rem 0 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .signals-list li {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.78rem;
  }
  .sig-source {
    text-transform: uppercase;
    font-size: 0.65rem;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    min-width: 4rem;
  }
  .sig-severity {
    font-size: 0.65rem;
  }
  .sig-count {
    color: var(--text-tertiary);
  }
  .expand-meta {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    font-size: 0.72rem;
    color: var(--text-tertiary);
  }
  .expand-meta .err {
    color: var(--status-error);
  }
  .muted {
    color: var(--text-tertiary);
  }
  .link {
    color: var(--accent-primary);
    text-decoration: none;
    font-size: 0.8rem;
  }
  .link:hover {
    text-decoration: underline;
  }
  .toast {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    padding: 0.6rem 0.9rem;
    border-radius: var(--radius-sm);
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    box-shadow: var(--shadow-md);
    font-size: 0.85rem;
    color: var(--text-primary);
    z-index: 50;
    max-width: min(420px, 90vw);
  }
  .toast-ok {
    border-color: var(--status-success);
  }
  .toast-err {
    border-color: var(--status-error);
    color: var(--status-error);
  }
  .toast-info {
    border-color: var(--accent-primary);
  }
</style>
