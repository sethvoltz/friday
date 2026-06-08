<script lang="ts">
  import type { PageData } from "./$types";
  import type { Ticket, TicketKind, TicketStatus } from "@friday/shared/services";
  import {
    useZero,
    zeroSync,
    type ZeroTicketRow,
  } from "$lib/stores/zero.svelte";
  import { nextTicketIdFrom } from "@friday/shared/sync";

  let { data }: { data: PageData } = $props();

  // Phase 3.1 (ADR-024): when the Zero flag is on, the tickets list is
  // sourced from the reactive Zero query (`zeroSync.tickets`).
  // Otherwise the existing SSR-then-manual-refresh REST path is used,
  // unchanged. The flag is single-switch via `useZero()`.
  // Phase 3.1 (ADR-024): keep `tickets` as a mutable $state so the
  // existing call sites (statusCount, filtered, etc.) continue to read
  // a plain array. When the Zero flag is on, an effect pushes the
  // Zero-streamed rows in; when off, the original REST path
  // (refresh()) updates the same state. Either way, downstream code
  // sees one source-of-truth array.
  const zeroOn = useZero();
  // svelte-ignore state_referenced_locally
  let tickets = $state<Ticket[]>(data.tickets);
  $effect(() => {
    if (zeroOn) {
      tickets = zeroSync.tickets.map(toTicket);
    }
  });
  function toTicket(r: ZeroTicketRow): Ticket {
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      status: r.status,
      kind: r.kind,
      assignee: r.assignee,
      meta: r.meta_json,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  // Statuses hidden by default; each has a toggle chip to show them.
  // open + in_progress are always visible.
  const TOGGLEABLE: TicketStatus[] = ["done", "closed", "blocked"];

  function initialExtraShown(): Set<TicketStatus> {
    if (typeof window === "undefined") return new Set();
    const params = new URLSearchParams(window.location.search);
    return new Set(
      params.getAll("show").filter((s): s is TicketStatus =>
        TOGGLEABLE.includes(s as TicketStatus),
      ),
    );
  }
  let extraShown = $state<Set<TicketStatus>>(initialExtraShown());

  $effect(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete("show");
    for (const s of extraShown) params.append("show", s);
    const qs = params.toString();
    history.replaceState(history.state, "", qs ? `?${qs}` : location.pathname);
  });

  function toggleExtra(s: TicketStatus) {
    const next = new Set(extraShown);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    extraShown = next;
  }

  let assigneeFilter = $state<string>("all");
  let sortKey = $state<"updated" | "created" | "id" | "title" | "status">(
    "updated",
  );
  let sortDir = $state<"asc" | "desc">("desc");

  let creating = $state(false);
  let newOpen = $state(false);
  let newTitle = $state("");
  let newBody = $state("");
  let newKind = $state<TicketKind>("task");
  let newAssignee = $state("");

  // `$derived(() => ...)` would make the derived value the closure
  // itself; we want the closure's *result*, memoized. That's `$derived.by`.
  const assignees = $derived.by<string[]>(() => {
    const set = new Set<string>();
    for (const t of tickets) if (t.assignee) set.add(t.assignee);
    return [...set].sort();
  });

  function statusCount(s: TicketStatus): number {
    return tickets.filter((t) => t.status === s).length;
  }

  const filtered = $derived.by<Ticket[]>(() => {
    let out = tickets.filter(
      (t) =>
        t.status === "open" ||
        t.status === "in_progress" ||
        extraShown.has(t.status),
    );
    if (assigneeFilter !== "all") {
      if (assigneeFilter === "unassigned") {
        out = out.filter((t) => !t.assignee);
      } else {
        out = out.filter((t) => t.assignee === assigneeFilter);
      }
    }
    const dir = sortDir === "asc" ? 1 : -1;
    const sorted = [...out].sort((a, b) => {
      switch (sortKey) {
        case "updated":
          return (a.updatedAt - b.updatedAt) * dir;
        case "created":
          return (a.createdAt - b.createdAt) * dir;
        case "id": {
          const an = Number(a.id.split("-")[1] ?? 0);
          const bn = Number(b.id.split("-")[1] ?? 0);
          return (an - bn) * dir;
        }
        case "title":
          return a.title.localeCompare(b.title) * dir;
        case "status":
          return a.status.localeCompare(b.status) * dir;
      }
    });
    return sorted;
  });

  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = key === "title" || key === "status" ? "asc" : "desc";
    }
  }

  function sortIndicator(key: typeof sortKey): string {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

  async function refresh() {
    // When Zero is the source of truth the reactive query handles
    // updates automatically; no manual refresh needed.
    if (zeroOn) return;
    try {
      const r = await fetch("/api/tickets");
      if (!r.ok) return;
      tickets = (await r.json()) as Ticket[];
    } catch {
      // ignore
    }
  }

  async function createNew(e: Event) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    creating = true;
    try {
      if (zeroOn) {
        // Phase 4.4: optimistic create via Zero mutator. id is
        // computed from the local reactive snapshot — races between
        // tabs surface as a PK conflict the framework reports back.
        const id = nextTicketIdFrom(zeroSync.tickets);
        const result = zeroSync.createTicket({
          id,
          title: newTitle.trim(),
          body: newBody.trim() || undefined,
          kind: newKind,
          assignee: newAssignee.trim() || undefined,
        });
        // Wait for the server-side run to either commit or report a
        // PK collision (race-loss). Either way, clear the form so the
        // optimistic row stays visible.
        const serverResult = await result?.server;
        if (serverResult && serverResult.type === "error") {
          // PK race: leave the form populated so the user can retry.
          return;
        }
        newTitle = "";
        newBody = "";
        newAssignee = "";
        newKind = "task";
        newOpen = false;
        return;
      }
      const r = await fetch("/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: newTitle.trim(),
          body: newBody.trim() || undefined,
          kind: newKind,
          assignee: newAssignee.trim() || undefined,
        }),
      });
      if (r.ok) {
        newTitle = "";
        newBody = "";
        newAssignee = "";
        newKind = "task";
        newOpen = false;
        await refresh();
      }
    } finally {
      creating = false;
    }
  }

  function badgeClass(status: string): string {
    if (status === "done" || status === "closed") return "ok";
    if (status === "in_progress") return "ok";
    if (status === "blocked") return "error";
    return "warn";
  }
</script>

<header class="page-head">
  <h1>Tickets</h1>
  <p class="page-lead">Internal coordination + external system links.</p>
</header>

<div class="card">
  <div class="card-header">
    <h2>Filters</h2>
    <button
      type="button"
      class="ghost primary"
      onclick={() => (newOpen = !newOpen)}>
      {newOpen ? "Cancel" : "New ticket"}
    </button>
  </div>
  <div class="chip-row">
    <span class="chip-label">Show</span>
    <span class="chip always-on">open ({statusCount("open")})</span>
    <span class="chip always-on">in_progress ({statusCount("in_progress")})</span>
    {#each TOGGLEABLE as s (s)}
      <button
        type="button"
        class="chip"
        class:selected={extraShown.has(s)}
        onclick={() => toggleExtra(s)}>
        {s} ({statusCount(s)})
      </button>
    {/each}
  </div>
  <div class="chip-row">
    <span class="chip-label">Assignee</span>
    <button
      type="button"
      class="chip"
      class:selected={assigneeFilter === "all"}
      onclick={() => (assigneeFilter = "all")}>
      all
    </button>
    <button
      type="button"
      class="chip"
      class:selected={assigneeFilter === "unassigned"}
      onclick={() => (assigneeFilter = "unassigned")}>
      unassigned
    </button>
    {#each assignees as a (a)}
      <button
        type="button"
        class="chip"
        class:selected={assigneeFilter === a}
        onclick={() => (assigneeFilter = a)}>
        {a}
      </button>
    {/each}
  </div>
</div>

{#if newOpen}
  <div class="card">
    <div class="card-header"><h2>New ticket</h2></div>
    <form class="newform" onsubmit={createNew}>
      <label class="field">
        <span class="row-label">Title</span>
        <input class="input" bind:value={newTitle} required />
      </label>
      <label class="field">
        <span class="row-label">Body (markdown, optional)</span>
        <textarea class="textarea" rows="5" bind:value={newBody}></textarea>
      </label>
      <div class="field-row">
        <label class="field">
          <span class="row-label">Kind</span>
          <select class="input" bind:value={newKind}>
            <option value="task">task</option>
            <option value="epic">epic</option>
            <option value="bug">bug</option>
            <option value="chore">chore</option>
          </select>
        </label>
        <label class="field">
          <span class="row-label">Assignee</span>
          <input class="input" bind:value={newAssignee} placeholder="optional" />
        </label>
      </div>
      <div class="actions">
        <button
          type="submit"
          class="ghost primary"
          disabled={creating || !newTitle.trim()}>
          {creating ? "Creating…" : "Create ticket"}
        </button>
      </div>
    </form>
  </div>
{/if}

<div class="card">
  <div class="card-header">
    <h2>Tickets</h2>
    <span class="stat-detail">{filtered.length} shown · {tickets.length} total</span>
  </div>
  {#if filtered.length === 0}
    <p class="empty-state">
      No tickets match. Loosen the filters above or create one.
    </p>
  {:else}
    <div class="table-scroll-wrapper">
    <table class="data-table sortable">
      <thead>
        <tr>
          <th class="sortable-col" onclick={() => toggleSort("id")}>
            ID{sortIndicator("id")}
          </th>
          <th class="sortable-col" onclick={() => toggleSort("title")}>
            Title{sortIndicator("title")}
          </th>
          <th>Kind</th>
          <th class="sortable-col" onclick={() => toggleSort("status")}>
            Status{sortIndicator("status")}
          </th>
          <th>Assignee</th>
          <th class="sortable-col" onclick={() => toggleSort("updated")}>
            Updated{sortIndicator("updated")}
          </th>
        </tr>
      </thead>
      <tbody>
        {#each filtered as t (t.id)}
          <tr>
            <td><a href="/tickets/{t.id}" class="link-mono">{t.id}</a></td>
            <td><a href="/tickets/{t.id}" class="link-title">{t.title}</a></td>
            <td>{t.kind}</td>
            <td>
              <span class="badge {badgeClass(t.status)}">{t.status}</span>
            </td>
            <td>{t.assignee ?? "—"}</td>
            <td class="text-xs muted">{new Date(t.updatedAt).toLocaleString()}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    </div>
  {/if}
</div>

<style>
  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
    margin: 0.4rem 0;
    font-size: 0.85rem;
  }
  .chip-label {
    color: var(--text-tertiary);
    text-transform: uppercase;
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    font-weight: 600;
    margin-right: 0.3rem;
  }
  .chip {
    padding: 0.25rem 0.65rem;
    border-radius: 99px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 0.78rem;
    cursor: pointer;
  }
  .chip:hover {
    color: var(--text-primary);
  }
  .chip.selected {
    background: var(--accent-glow);
    border-color: var(--accent-primary);
    color: var(--text-primary);
  }
  .chip.always-on {
    opacity: 0.5;
    cursor: default;
    pointer-events: none;
  }
  .newform {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .field-row {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .field-row .field {
    flex: 1;
    min-width: 160px;
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
    width: 100%;
    padding: 0.5rem 0.6rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.9rem;
    font-family: inherit;
  }
  .textarea {
    font-family: var(--font-mono);
    resize: vertical;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  button.primary {
    color: var(--accent-primary);
    border-color: var(--accent-primary);
  }
  .sortable-col {
    cursor: pointer;
    user-select: none;
  }
  .sortable-col:hover {
    color: var(--accent-primary);
  }
  .link-mono {
    color: var(--accent-primary);
    font-family: var(--font-mono);
    text-decoration: none;
    white-space: nowrap;
  }
  .link-title {
    color: var(--text-primary);
    text-decoration: none;
    font-weight: 500;
  }
  .link-mono:hover,
  .link-title:hover {
    text-decoration: underline;
  }
  .text-xs {
    font-size: 0.72rem;
  }
  .muted {
    color: var(--text-tertiary);
  }
  @media (max-width: 1023px) {
    .input,
    .textarea {
      font-size: 16px;
    }
  }
</style>
