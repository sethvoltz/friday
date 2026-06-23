<script lang="ts">
  /**
   * FRI-142 (ADR-048) — the Settings "Notifications" card.
   *
   * Surfaces the user-facing controls over the daemon's Notification router:
   *   - Per-event PRESET chips (Auto / Always push / Toast only / Off). The
   *     presets are sugar — selecting one WRITES the concrete `notify_policy`
   *     per-channel rules for that event (the map is the truth; see
   *     `notify-policy.ts`). Reads + writes flow through the Zero-replicated
   *     `settings` singleton row (`zeroSync.settings[0]` / `updateSettings`).
   *   - DND window (start/end "HH:MM" time inputs) — suppresses Push.
   *   - The critical-bypass master toggle — lets the `critical` class
   *     (evolve_critical, mail priority='critical') punch through DND.
   *   - Web Push subscribe/permission flow + a "Send test notification" button.
   *
   * Every policy/DND/toggle write is a single `updateSettings` mutator call;
   * the reactive `liveSettings` derivation mirrors the canonical row back so a
   * cross-tab/device change converges the controls. Push subscribe is a
   * user-gesture flow (iOS requirement) gated behind the Subscribe button.
   */
  import { onMount } from "svelte";
  import { Bell, BellOff, Send } from "lucide-svelte";
  import { zeroSync } from "$lib/stores/zero.svelte";
  import Toggle from "$lib/components/Toggle/Toggle.svelte";
  import {
    NOTIFY_EVENT_TYPES,
    type NotifyEventType,
    type NotifyPolicy,
  } from "@friday/shared/sync";
  import {
    NOTIFY_PRESETS,
    EVENT_LABELS,
    presetForEvent,
    presetMutatorArg,
    dndMutatorArg,
    criticalBypassMutatorArg,
    type NotifyPreset,
  } from "./notify-policy";
  import {
    pushState,
    refreshPushState,
    subscribeToPush,
  } from "$lib/stores/push.svelte";

  // Live settings row off Zero. The Settings page guarantees the singleton row
  // exists (migration-seeded); until Zero's first sync lands `settings` may be
  // empty, so we tolerate `undefined` and fall back to "no overrides" defaults.
  const row = $derived(zeroSync.settings[0]);
  const policy = $derived<NotifyPolicy | null>((row?.notify_policy ?? null) as NotifyPolicy | null);
  const dndStart = $derived(row?.dnd_start ?? "");
  const dndEnd = $derived(row?.dnd_end ?? "");
  // `critical_bypass_dnd` is NOT NULL default true in Postgres; treat a missing
  // row (pre-sync) as the default `true` so the toggle doesn't flicker off.
  const criticalBypass = $derived(row?.critical_bypass_dnd ?? true);

  /** Select a preset for one event — writes the materialized rule pair. */
  function choosePreset(event: NotifyEventType, preset: NotifyPreset): void {
    zeroSync.updateSettings(presetMutatorArg(policy, event, preset));
  }

  /** Commit a DND bound. An empty input clears that bound (`null` ⇒ no DND). */
  function onDndStart(e: Event): void {
    zeroSync.updateSettings(dndMutatorArg("start", (e.target as HTMLInputElement).value));
  }
  function onDndEnd(e: Event): void {
    zeroSync.updateSettings(dndMutatorArg("end", (e.target as HTMLInputElement).value));
  }

  // The critical-bypass toggle. `bind:checked` drives a local mirror; a
  // separate `$effect` writes the mutator only when the bound value diverges
  // from the canonical row, skipping the mount-time echo AND the cross-tab
  // mirror-back (same pattern as the Watchdog toggle). `lastCommitted` tracks
  // the last value we either read from the row or wrote, so a canonical update
  // re-syncs the input without re-firing the mutator.
  // svelte-ignore state_referenced_locally
  let bypassChecked = $state(criticalBypass);
  // svelte-ignore state_referenced_locally
  let lastCommitted = $state(criticalBypass);
  $effect(() => {
    // Canonical row changed (first sync or cross-tab) — mirror it into the
    // input and update the commit baseline so the writer effect stays quiet.
    if (criticalBypass !== lastCommitted) {
      lastCommitted = criticalBypass;
      bypassChecked = criticalBypass;
    }
  });
  $effect(() => {
    // User flipped the toggle — write once, advance the baseline.
    if (bypassChecked === lastCommitted) return;
    lastCommitted = bypassChecked;
    zeroSync.updateSettings(criticalBypassMutatorArg(bypassChecked));
  });

  // --- Push subscribe + test ---
  let subscribing = $state(false);
  let testState = $state<"idle" | "sending" | "ok" | "error">("idle");
  let testError = $state<string | null>(null);

  onMount(() => {
    // Read-only reconcile — no permission prompt (safe on mount).
    void refreshPushState();
  });

  async function onSubscribe(): Promise<void> {
    if (subscribing) return;
    subscribing = true;
    try {
      const deviceId = zeroSync.currentDeviceId;
      if (!deviceId) {
        pushState.error = "device-not-ready";
        return;
      }
      await subscribeToPush(deviceId);
    } finally {
      subscribing = false;
    }
  }

  async function onSendTest(): Promise<void> {
    if (testState === "sending") return;
    testState = "sending";
    testError = null;
    try {
      const r = await fetch("/api/notify/test", { method: "POST" });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(body.detail ?? body.error ?? `test failed (${r.status})`);
      }
      testState = "ok";
      setTimeout(() => (testState = "idle"), 3000);
    } catch (e) {
      testState = "error";
      testError = e instanceof Error ? e.message : "test failed";
      setTimeout(() => (testState = "idle"), 4000);
    }
  }

  function pushStatusLabel(): string {
    if (!pushState.supported) return "Not supported on this device";
    if (pushState.permission === "denied") return "Blocked in browser settings";
    if (pushState.subscribed) return "Subscribed";
    return "Not subscribed";
  }
</script>

<div class="card notifications-card">
  <div class="card-header"><h2>Notifications</h2></div>
  <p class="row-value">
    Choose how Friday reaches you for each kind of event. An in-app
    <strong>toast</strong> shows when you're here; a native
    <strong>push</strong> (and app-icon badge) reaches you when you're away.
  </p>

  <!-- Per-event preset rows -->
  <div class="event-list" role="group" aria-label="Notification rules by event">
    {#each NOTIFY_EVENT_TYPES as event (event)}
      {@const active = presetForEvent(policy, event)}
      <div class="event-row">
        <span class="event-label">{EVENT_LABELS[event]}</span>
        <div class="preset-group" role="radiogroup" aria-label={EVENT_LABELS[event]}>
          {#each NOTIFY_PRESETS as p (p.id)}
            <button
              type="button"
              class="preset-chip"
              class:selected={active === p.id}
              aria-pressed={active === p.id}
              onclick={() => choosePreset(event, p.id)}>
              {p.label}
            </button>
          {/each}
          {#if active === null}
            <span class="preset-custom" title="Hand-edited rules — pick a preset to reset">
              Custom
            </span>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <!-- Do Not Disturb -->
  <div class="settings-section">
    <div class="section-label">Do Not Disturb</div>
    <p class="row-value">
      Suppress push (and badge buzz) during these hours. Leave either field
      blank to turn DND off.
    </p>
    <div class="dnd-row">
      <label class="dnd-field">
        <span class="dnd-label">From</span>
        <input type="time" value={dndStart} onchange={onDndStart} aria-label="DND start" />
      </label>
      <label class="dnd-field">
        <span class="dnd-label">To</span>
        <input type="time" value={dndEnd} onchange={onDndEnd} aria-label="DND end" />
      </label>
    </div>
    <div class="toggle-row">
      <Toggle
        bind:checked={bypassChecked}
        label="Let critical alerts bypass Do Not Disturb" />
    </div>
  </div>

  <!-- Web Push subscribe + test -->
  <div class="settings-section">
    <div class="section-label">This device</div>
    <p class="row-value">
      Subscribe this device to native push. Requires installing Friday to your
      home screen and granting notification permission (iOS 16.4+).
    </p>
    <div class="push-status">
      <span class="push-status-dot" class:on={pushState.subscribed}></span>
      <span class="push-status-text">{pushStatusLabel()}</span>
    </div>
    {#if pushState.error}
      <p class="row-value err">Couldn't subscribe: {pushState.error}</p>
    {/if}
    <div class="actions">
      {#if pushState.subscribed}
        <button class="ghost" disabled>
          <Bell size={14} strokeWidth={2} aria-hidden="true" />
          Subscribed
        </button>
      {:else}
        <button
          class="ghost"
          onclick={onSubscribe}
          disabled={subscribing || !pushState.supported || pushState.permission === "denied"}>
          {#if subscribing}
            Subscribing…
          {:else}
            <BellOff size={14} strokeWidth={2} aria-hidden="true" />
            Subscribe to push
          {/if}
        </button>
      {/if}
      <button class="ghost" onclick={onSendTest} disabled={testState === "sending"}>
        <Send size={14} strokeWidth={2} aria-hidden="true" />
        {#if testState === "sending"}
          Sending…
        {:else if testState === "ok"}
          Sent ✓
        {:else if testState === "error"}
          Failed — retry?
        {:else}
          Send test notification
        {/if}
      </button>
    </div>
    {#if testState === "error" && testError}
      <p class="row-value err">{testError}</p>
    {/if}
  </div>
</div>

<style>
  .notifications-card {
    grid-column: 1 / -1;
  }
  .event-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .event-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border-subtle);
  }
  .event-row:last-child {
    border-bottom: none;
  }
  .event-label {
    color: var(--text-primary);
    font-size: 0.85rem;
    min-width: 0;
  }
  .preset-group {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
  }
  .preset-chip {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 0.75rem;
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }
  .preset-chip:hover {
    color: var(--text-primary);
    border-color: var(--border-primary);
  }
  .preset-chip.selected {
    border-color: var(--accent-primary);
    background: var(--accent-glow);
    color: var(--accent-primary);
    font-weight: 600;
  }
  .preset-custom {
    font-size: 0.7rem;
    color: var(--text-tertiary);
    font-style: italic;
    margin-left: 0.25rem;
  }

  .settings-section {
    margin-top: 1.25rem;
  }
  .section-label {
    color: var(--text-tertiary);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .dnd-row {
    display: flex;
    gap: 1rem;
    margin-top: 0.5rem;
    flex-wrap: wrap;
  }
  .dnd-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .dnd-label {
    font-size: 0.7rem;
    color: var(--text-tertiary);
  }
  .dnd-field input[type="time"] {
    padding: 0.4rem 0.55rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    font-family: var(--font-mono);
  }
  .toggle-row {
    display: inline-flex;
    align-items: center;
    margin-top: 0.75rem;
    font-size: 0.9rem;
    color: var(--text-primary);
  }

  .push-status {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .push-status-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--text-tertiary);
    flex-shrink: 0;
  }
  .push-status-dot.on {
    background: var(--status-success);
  }
  .push-status-text {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
  .actions {
    margin-top: 1rem;
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .actions .ghost {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .row-value.err {
    color: var(--status-error);
  }
</style>
