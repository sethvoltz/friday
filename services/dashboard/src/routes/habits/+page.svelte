<script lang="ts">
  // FRI-169 — /habits management route.
  //
  // The first-class Habit surface: a list of active Habits as summary rows
  // ([N <unit> streak] | square strip | +k), each expandable to a full
  // Sun→Sat Check-in calendar, plus create / edit / archive controls.
  //
  // Data + write paths (the workflow's pinned split, honouring ticket §9
  // default (b)):
  //   • LIVE LIST  — `zeroSync.habits` / `zeroSync.habitCheckins` reactive
  //     bindings (so check-offs and edits reflect live), with the SSR
  //     `data.habits` snapshot as the pre-hydration fallback.
  //   • CHECK-OFF + UNDO — NOT on this page (that's the Today card). Here the
  //     detail view check-off uses the `zeroSync.habitCheckin` mutator too.
  //   • CREATE / EDIT / ARCHIVE — POST/PATCH to the /api/habits daemon routes
  //     through the dashboard's /api proxy (mirrors how /schedules POSTs to
  //     /api/schedules). Low-frequency management writes; one code path the
  //     MCP tools also use.
  //
  // Archive uses the project ConfirmDialog modal (never window.confirm).

  import type { PageData } from "./$types";
  import { confirmDialog } from "$lib/components/ConfirmDialog/store.svelte";
  import { useZero, zeroSync } from "$lib/stores/zero.svelte";
  import {
    type ZeroHabitRow,
    type ZeroHabitCheckinRow,
  } from "$lib/habits/adapt";
  import HabitSummaryRow from "$lib/components/Habits/HabitSummaryRow.svelte";
  import HabitCalendar from "$lib/components/Habits/HabitCalendar.svelte";
  import HabitColorPicker from "$lib/components/Habits/HabitColorPicker.svelte";

  let { data }: { data: PageData } = $props();

  const zeroOn = useZero();

  // Live list under the Zero flag; SSR snapshot otherwise. Same pattern as
  // /schedules — keep `habits` a mutable $state and push Zero rows in via an
  // $effect so the partitioning/handlers downstream stay source-agnostic.
  // svelte-ignore state_referenced_locally
  let habits = $state<ZeroHabitRow[]>(data.habits);
  let checkins = $state<ZeroHabitCheckinRow[]>([]);
  $effect(() => {
    if (zeroOn) {
      habits = zeroSync.habits;
      checkins = zeroSync.habitCheckins;
    }
  });

  // Per-habit Check-in slices, memoised by habit id, so each row/calendar gets
  // only its own log (the engine tallies whatever it's handed).
  const checkinsByHabit = $derived.by(() => {
    const m = new Map<string, ZeroHabitCheckinRow[]>();
    for (const c of checkins) {
      const arr = m.get(c.habit_id);
      if (arr) arr.push(c);
      else m.set(c.habit_id, [c]);
    }
    return m;
  });
  function checkinsFor(id: string): ZeroHabitCheckinRow[] {
    return checkinsByHabit.get(id) ?? [];
  }

  // Active habits up top; terminal (archived/completed/expired) below,
  // de-emphasized. Each list is name-sorted for a stable reading order.
  const activeHabits = $derived(
    habits
      .filter((h) => h.status === "active")
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  const terminalHabits = $derived(
    habits
      .filter((h) => h.status !== "active")
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  // Inline-expanded detail (one open at a time keeps the page scannable).
  let expandedId = $state<string | null>(null);
  function toggleExpand(id: string) {
    expandedId = expandedId === id ? null : id;
  }

  let busy = $state<string | null>(null);
  let toast = $state<{ msg: string; kind: "ok" | "err" | "info" } | null>(null);
  function showToast(msg: string, kind: "ok" | "err" | "info" = "ok") {
    toast = { msg, kind };
    setTimeout(() => {
      toast = null;
    }, 4500);
  }

  // --- Create form ------------------------------------------------------
  type Mode = "ongoing" | "bounded";
  type Period = "day" | "week" | "month" | "year";
  type Bucket = "morning" | "afternoon" | "evening" | "anytime";

  let showCreate = $state(false);
  let cName = $state("");
  let cDescription = $state("");
  let cMode = $state<Mode>("ongoing");
  let cPeriod = $state<Period>("day");
  let cTarget = $state(1);
  let cBucket = $state<Bucket>("anytime");
  let cColorIndex = $state(1);
  // Weekday mask (Sun=bit0 … Sat=bit6), only when period='day'.
  let cDays = $state<boolean[]>([true, true, true, true, true, true, true]);
  let cWindowStart = $state("");
  let cWindowEnd = $state("");

  const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  // The mask is meaningful only for a day-Period habit; a full mask (all 7)
  // means "every day" and is sent as null (no constraint), matching the
  // engine's unmasked semantics.
  function maskFromDays(days: boolean[]): number | null {
    let mask = 0;
    for (let i = 0; i < 7; i++) if (days[i]) mask |= 1 << i;
    if (mask === 0b1111111) return null; // every day → unconstrained
    return mask;
  }

  function resetCreateForm() {
    cName = "";
    cDescription = "";
    cMode = "ongoing";
    cPeriod = "day";
    cTarget = 1;
    cBucket = "anytime";
    cColorIndex = 1;
    cDays = [true, true, true, true, true, true, true];
    cWindowStart = "";
    cWindowEnd = "";
  }

  async function createHabit() {
    if (busy) return;
    if (!cName.trim()) {
      showToast("name is required", "err");
      return;
    }
    busy = "create";
    try {
      const body: Record<string, unknown> = {
        name: cName.trim(),
        description: cDescription.trim() || null,
        mode: cMode,
        period: cPeriod,
        target: Math.max(1, Number(cTarget) || 1),
        bucket: cBucket,
        colorIndex: cColorIndex,
        // days_of_week only travels for a day-Period habit (orthogonality
        // guard on the daemon/DB side rejects a mask on other periods).
        daysOfWeek: cPeriod === "day" ? maskFromDays(cDays) : null,
        windowStart:
          cMode === "bounded" && cWindowStart ? cWindowStart : null,
        windowEnd: cMode === "bounded" && cWindowEnd ? cWindowEnd : null,
      };
      const r = await fetch("/api/habits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const detail = await readError(r);
        showToast(`create failed: ${detail}`, "err");
        return;
      }
      showToast(`created ${cName.trim()}`);
      resetCreateForm();
      showCreate = false;
      // Under Zero the new row replicates in; SSR-only mode won't auto-refresh
      // but the daemon row is created regardless.
    } finally {
      busy = null;
    }
  }

  // --- Edit (inline color/target/bucket patch) --------------------------
  async function patchHabit(id: string, patch: Record<string, unknown>) {
    if (busy) return;
    busy = `edit ${id}`;
    try {
      const r = await fetch(`/api/habits/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) {
        const detail = await readError(r);
        showToast(`save failed: ${detail}`, "err");
        return;
      }
      showToast("saved");
    } finally {
      busy = null;
    }
  }

  // --- Archive (preserve over delete) -----------------------------------
  async function archiveHabit(habit: ZeroHabitRow) {
    const ok = await confirmDialog({
      title: `Archive "${habit.name}"?`,
      description:
        "The habit stops appearing in the Today card and active list, but all its Check-in history is preserved — nothing is deleted. You can find it in the archived list below.",
      confirmLabel: "Archive",
      danger: true,
    });
    if (!ok) return;
    busy = `archive ${habit.id}`;
    try {
      const r = await fetch(
        `/api/habits/${encodeURIComponent(habit.id)}/archive`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      if (!r.ok) {
        const detail = await readError(r);
        showToast(`archive failed: ${detail}`, "err");
        return;
      }
      showToast(`archived ${habit.name}`);
    } finally {
      busy = null;
    }
  }

  // --- Check-off from the detail view (Zero mutator, optimistic) ---------
  async function checkOff(habit: ZeroHabitRow) {
    if (!zeroOn) {
      // SSR-only fallback: POST a Check-in through the daemon route.
      busy = `checkin ${habit.id}`;
      try {
        await fetch(`/api/habits/${encodeURIComponent(habit.id)}/checkin`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        showToast(`checked off ${habit.name}`);
      } finally {
        busy = null;
      }
      return;
    }
    const result = zeroSync.habitCheckin({ habit_id: habit.id });
    const sr = await result?.server;
    if (sr && sr.type === "error") {
      showToast(`check-off failed: ${sr.error.message}`, "err");
      return;
    }
    showToast(`checked off ${habit.name}`);
  }

  async function readError(r: Response): Promise<string> {
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.error === "string") return body.error;
    if (typeof body.detail === "string") return body.detail;
    return `${r.status}`;
  }

  function fmtWindow(
    start: number | null | undefined,
    end: number | null | undefined,
  ): string | null {
    if (start == null && end == null) return null;
    const f = (ms: number | null | undefined) =>
      ms != null ? new Date(ms).toLocaleDateString() : "…";
    return `${f(start)} → ${f(end)}`;
  }
</script>

<header class="page-head">
  <h1>Habits</h1>
  <p class="page-lead">
    Recurring things you check off. The streak is the run of consecutive
    satisfied periods — derived live from your check-ins, never stored.
  </p>
</header>

<div class="card">
  <div class="card-header">
    <h2>Active habits</h2>
    <div class="card-header-controls">
      <span class="stat-detail">{activeHabits.length} active</span>
      <button
        class="ghost compact"
        aria-expanded={showCreate}
        onclick={() => (showCreate = !showCreate)}>
        {showCreate ? "− Cancel" : "+ New habit"}
      </button>
    </div>
  </div>

  {#if showCreate}
    <form
      class="create-form"
      onsubmit={(e) => {
        e.preventDefault();
        createHabit();
      }}>
      <div class="form-grid">
        <label class="field">
          <span class="row-label">Name</span>
          <input
            class="input"
            type="text"
            placeholder="Morning run"
            bind:value={cName}
            required />
        </label>

        <label class="field">
          <span class="row-label">Description</span>
          <input
            class="input"
            type="text"
            placeholder="optional"
            bind:value={cDescription} />
        </label>

        <label class="field">
          <span class="row-label">Mode</span>
          <select class="input" bind:value={cMode}>
            <option value="ongoing">Ongoing</option>
            <option value="bounded">Bounded (window)</option>
          </select>
        </label>

        <label class="field">
          <span class="row-label">Period</span>
          <select class="input" bind:value={cPeriod}>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
            <option value="year">Year</option>
          </select>
        </label>

        <label class="field">
          <span class="row-label">Target (check-ins / period)</span>
          <input
            class="input"
            type="number"
            min="1"
            bind:value={cTarget} />
        </label>

        <label class="field">
          <span class="row-label">Time-of-day bucket</span>
          <select class="input" bind:value={cBucket}>
            <option value="anytime">Anytime</option>
            <option value="morning">Morning</option>
            <option value="afternoon">Afternoon</option>
            <option value="evening">Evening</option>
          </select>
        </label>
      </div>

      {#if cPeriod === "day"}
        <div class="field">
          <span class="row-label">Days of week</span>
          <div class="day-toggles" role="group" aria-label="Days of week">
            {#each DAY_LABELS as dl, i}
              <button
                type="button"
                class="day-toggle"
                class:on={cDays[i]}
                aria-pressed={cDays[i]}
                aria-label={dl}
                onclick={() => (cDays[i] = !cDays[i])}>
                {dl}
              </button>
            {/each}
          </div>
          <span class="field-hint">
            All seven selected = every day (no weekday constraint).
          </span>
        </div>
      {/if}

      {#if cMode === "bounded"}
        <div class="form-grid">
          <label class="field">
            <span class="row-label">Window start</span>
            <input class="input" type="date" bind:value={cWindowStart} />
          </label>
          <label class="field">
            <span class="row-label">Window end</span>
            <input class="input" type="date" bind:value={cWindowEnd} />
          </label>
        </div>
      {/if}

      <div class="field">
        <span class="row-label">Color</span>
        <HabitColorPicker bind:selected={cColorIndex} />
      </div>

      <div class="actions">
        <button
          type="submit"
          class="ghost primary"
          disabled={busy !== null || !cName.trim()}>
          {busy === "create" ? "Creating…" : "Create habit"}
        </button>
      </div>
    </form>
  {/if}

  {#if activeHabits.length === 0}
    <p class="empty-state">
      No active habits yet. Create one to start a streak.
    </p>
  {:else}
    <ul class="habit-list">
      {#each activeHabits as habit (habit.id)}
        {@const win = fmtWindow(habit.window_start, habit.window_end)}
        <li class="habit-item">
          <div class="habit-row">
            <button
              class="expand-btn"
              aria-expanded={expandedId === habit.id}
              aria-label={expandedId === habit.id
                ? `Collapse ${habit.name}`
                : `Expand ${habit.name}`}
              onclick={() => toggleExpand(habit.id)}>
              {expandedId === habit.id ? "−" : "+"}
            </button>
            <div class="summary-slot">
              <HabitSummaryRow
                row={habit}
                checkins={checkinsFor(habit.id)} />
            </div>
            <div class="habit-actions">
              <button
                class="ghost compact"
                onclick={() => checkOff(habit)}
                disabled={busy !== null}>
                Check off
              </button>
              <button
                class="ghost compact danger"
                onclick={() => archiveHabit(habit)}
                disabled={busy !== null}>
                Archive
              </button>
            </div>
          </div>

          {#if expandedId === habit.id}
            <div class="habit-detail">
              <div class="detail-meta">
                <span class="badge">{habit.mode}</span>
                <span class="badge">{habit.period}</span>
                {#if habit.target > 1}
                  <span class="badge">target {habit.target}</span>
                {/if}
                {#if habit.bucket}
                  <span class="badge info">{habit.bucket}</span>
                {/if}
                {#if win}
                  <span class="badge">{win}</span>
                {/if}
              </div>
              {#if habit.description}
                <p class="detail-desc">{habit.description}</p>
              {/if}

              <div class="detail-calendar">
                <HabitCalendar
                  row={habit}
                  checkins={checkinsFor(habit.id)} />
              </div>

              <div class="detail-edit">
                <span class="row-label">Color</span>
                <div
                  class="detail-edit-actions"
                  role="group"
                  aria-label="Edit color for {habit.name}">
                  {#each [1, 2, 3, 4, 5, 6, 7] as slot}
                    <button
                      class="mini-swatch"
                      class:on={habit.color_index === slot}
                      style="background: var(--habit-{slot});"
                      aria-label="Set color {slot}"
                      aria-pressed={habit.color_index === slot}
                      disabled={busy !== null}
                      onclick={() =>
                        patchHabit(habit.id, { colorIndex: slot })}
                    ></button>
                  {/each}
                </div>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

{#if terminalHabits.length > 0}
  <div class="card terminal-card">
    <div class="card-header">
      <h2>Archived &amp; completed</h2>
      <span class="stat-detail">{terminalHabits.length} total</span>
    </div>
    <ul class="habit-list dim">
      {#each terminalHabits as habit (habit.id)}
        <li class="habit-item">
          <div class="habit-row">
            <button
              class="expand-btn"
              aria-expanded={expandedId === habit.id}
              aria-label={expandedId === habit.id
                ? `Collapse ${habit.name}`
                : `Expand ${habit.name}`}
              onclick={() => toggleExpand(habit.id)}>
              {expandedId === habit.id ? "−" : "+"}
            </button>
            <div class="summary-slot">
              <HabitSummaryRow row={habit} checkins={checkinsFor(habit.id)} />
            </div>
            <span class="badge {habit.status === 'completed' ? 'ok' : ''}">
              {habit.status}
            </span>
          </div>
          {#if expandedId === habit.id}
            <div class="habit-detail">
              <div class="detail-calendar">
                <HabitCalendar row={habit} checkins={checkinsFor(habit.id)} />
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}

{#if toast}
  <div class="toast toast-{toast.kind}" role="status" aria-live="polite">
    {toast.msg}
  </div>
{/if}

<style>
  .card-header-controls {
    display: inline-flex;
    align-items: center;
    gap: 0.75rem;
  }
  .ghost.compact {
    font-size: 0.75rem;
    padding: 0.25rem 0.55rem;
  }
  button.primary {
    color: var(--accent-primary);
    border-color: var(--accent-primary);
  }

  .create-form {
    margin: 0.5rem 0 1rem;
    padding: 1rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  .form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
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
  .input {
    width: 100%;
    padding: 0.5rem 0.6rem;
    background: var(--bg-card);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    font-family: inherit;
  }
  .field-hint {
    color: var(--text-tertiary);
    font-size: 0.7rem;
  }

  .day-toggles {
    display: inline-flex;
    gap: 0.3rem;
    flex-wrap: wrap;
  }
  .day-toggle {
    width: 34px;
    height: 32px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-card);
    color: var(--text-secondary);
    font-size: 0.75rem;
    cursor: pointer;
  }
  .day-toggle.on {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
    background: var(--accent-glow);
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .habit-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .habit-list.dim {
    opacity: 0.7;
  }
  .habit-item {
    border-bottom: 1px solid var(--border-subtle);
  }
  .habit-item:last-child {
    border-bottom: none;
  }
  .habit-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .expand-btn {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-card);
    color: var(--text-secondary);
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
  }
  .expand-btn:hover {
    color: var(--text-primary);
  }
  .summary-slot {
    flex: 1 1 auto;
    min-width: 0;
  }
  .habit-actions {
    flex: 0 0 auto;
    display: inline-flex;
    gap: 0.3rem;
  }

  .habit-detail {
    padding: 0.5rem 0 1rem 2rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .detail-meta {
    display: inline-flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .detail-desc {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
  .detail-calendar {
    overflow-x: auto;
  }
  .detail-edit {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .detail-edit-actions {
    display: inline-flex;
    gap: 0.3rem;
  }
  .mini-swatch {
    width: 22px;
    height: 22px;
    border-radius: var(--radius-sm);
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
  }
  .mini-swatch.on {
    border-color: var(--accent-primary);
    box-shadow: 0 0 0 2px var(--bg-card), 0 0 0 4px var(--accent-glow);
  }
  .mini-swatch:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }

  .terminal-card {
    margin-top: 1rem;
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

  @media (max-width: 1023px) {
    .input {
      font-size: 16px;
    }
  }
</style>
