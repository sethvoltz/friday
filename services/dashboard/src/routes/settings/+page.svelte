<script lang="ts">
  import type { PageData } from "./$types";
  import { invalidateAll } from "$app/navigation";
  import { confirmDialog } from "$lib/components/ConfirmDialog/store.svelte";
  import { Sun, Moon, MonitorCog } from "lucide-svelte";
  import { setMode, userPrefersMode } from "mode-watcher";
  import { useZero, zeroSync } from "$lib/stores/zero.svelte";

  type Mode = "light" | "dark" | "system";
  import Toggle from "$lib/components/Toggle/Toggle.svelte";
  import {
    wakeLockSettings,
    wakeLockState,
  } from "$lib/stores/wake-lock.svelte";
  import type { AppSummary } from "./+page.server";
  let { data }: { data: PageData } = $props();

  // Phase 3.4 (ADR-024): when the Zero flag is on, derive the
  // installed-apps panel from `zeroSync.apps` joined against
  // `zeroSync.agents` + `zeroSync.schedules` (already reactive).
  // Falls back to the SSR-loaded `data.apps` when the flag is off.
  const zeroOn = useZero();
  const apps = $derived.by<AppSummary[]>(() => {
    if (!zeroOn) return data.apps;
    const allAgents = zeroSync.agents;
    const allSchedules = zeroSync.schedules;
    return zeroSync.apps.map((r) => {
      const manifest = r.manifest_json ?? null;
      return {
        id: r.id,
        name: r.name,
        version: r.version,
        status: r.status,
        installedAt: r.installed_at,
        folderPath: r.folder_path,
        agents: allAgents
          .filter((a) => a.app_id === r.id)
          .map((a) => ({ name: a.name, type: a.type, status: a.status })),
        schedules: allSchedules
          .filter((s) => s.app_id === r.id)
          .map((s) => ({ name: s.name, cron: s.cron })),
        mcpServers: (manifest?.mcpServers ?? []).map((m) => ({
          name: m.name,
        })),
      };
    });
  });

  // Hydrate the wake-lock setting on first paint (SSR-safe: hydrate() reads
  // localStorage behind a typeof guard).
  wakeLockSettings.hydrate();

  let wakeLockEnabled = $state(wakeLockSettings.enabled);
  $effect(() => {
    if (wakeLockEnabled !== wakeLockSettings.enabled) {
      wakeLockSettings.set(wakeLockEnabled);
    }
  });

  // Theme selection is owned by mode-watcher (localStorage
  // `mode-watcher-mode`). The header `⌘K` palette exposes the same three
  // modes; this card is the discoverable surface for users who haven't
  // learned the palette yet.
  const selectedMode = $derived<Mode>(userPrefersMode.current ?? "system");

  // FIX_FORWARD 6.3 + Phase 4.3: configurable Friday settings (model +
  // watchdog). Under Zero (`useZero()`), the live values come from the
  // reactive `zeroSync.settings` singleton row and writes go through
  // the `updateSettings` mutator; the daemon's LISTEN handler re-syncs
  // ~/.friday/config.json so worker spawns see the new value on the
  // next read (no restart required). The SSR `data.settings` seed
  // covers first paint before Zero's WS handshake completes.
  const liveSettings = $derived.by<{ model: string; watchdogRefork: boolean }>(
    () => {
      if (!zeroOn) {
        return {
          model: data.settings.model,
          watchdogRefork: data.settings.watchdogRefork,
        };
      }
      const row = zeroSync.settings[0];
      return {
        model: row?.model ?? data.settings.model,
        watchdogRefork: row?.watchdog_refork ?? data.settings.watchdogRefork,
      };
    },
  );
  // Two-way bindings for the form inputs. `$effect` mirrors the
  // derived live values into the writable state so cross-tab updates
  // converge the inputs without trampling an in-progress edit.
  // svelte-ignore state_referenced_locally
  let model = $state(data.settings.model);
  // svelte-ignore state_referenced_locally
  let watchdogRefork = $state(data.settings.watchdogRefork);
  let savingSettings = $state(false);

  $effect(() => {
    if (!zeroOn) return;
    if (savingSettings) return; // don't trample an in-flight save
    model = liveSettings.model;
    watchdogRefork = liveSettings.watchdogRefork;
  });

  const MODEL_OPTIONS: Array<{ id: string; label: string }> = [
    { id: "claude-opus-4-7", label: "Claude Opus 4.7 — best for reasoning" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — balanced" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — fast / cheap" },
  ];

  // svelte-ignore state_referenced_locally
  let priorModel = $state(data.settings.model);
  // svelte-ignore state_referenced_locally
  let priorWatchdog = $state(data.settings.watchdogRefork);
  let settingsToast = $state<{ msg: string; kind: "ok" | "err" } | null>(null);

  function showSettingsToast(msg: string, kind: "ok" | "err") {
    settingsToast = { msg, kind };
    setTimeout(() => {
      settingsToast = null;
    }, 4500);
  }

  async function patchSettings(body: {
    model?: string;
    watchdogRefork?: boolean;
  }) {
    savingSettings = true;
    try {
      if (zeroOn) {
        // Phase 4.3: write via the Zero mutator. Optimistic client
        // write lands immediately; the canonical Postgres UPSERT and
        // daemon's LISTEN-driven config.json resync follow within a
        // second. The reactive `$effect` above will mirror the new
        // values back into the inputs once they arrive — until then
        // the inputs reflect the user's keystrokes.
        zeroSync.updateSettings(body);
        priorModel = body.model ?? priorModel;
        priorWatchdog = body.watchdogRefork ?? priorWatchdog;
        showSettingsToast("saved", "ok");
        return;
      }
      // Legacy REST path — only reachable with Zero disabled.
      let r: Response;
      try {
        r = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (err) {
        model = priorModel;
        watchdogRefork = priorWatchdog;
        showSettingsToast(
          `save failed: ${err instanceof Error ? err.message : String(err)}`,
          "err",
        );
        return;
      }
      if (!r.ok) {
        const detail = await r
          .json()
          .then((j: { detail?: string }) => j.detail)
          .catch(() => null);
        model = priorModel;
        watchdogRefork = priorWatchdog;
        showSettingsToast(
          detail ? `save failed: ${detail}` : `save failed (${r.status})`,
          "err",
        );
        return;
      }
      const fresh = (await r.json()) as {
        model: string;
        watchdogRefork: boolean;
      };
      model = fresh.model;
      watchdogRefork = fresh.watchdogRefork;
      priorModel = fresh.model;
      priorWatchdog = fresh.watchdogRefork;
      showSettingsToast("saved · restart daemon for changes to take effect", "ok");
    } finally {
      savingSettings = false;
    }
  }

  async function onModelChange(e: Event) {
    const next = (e.target as HTMLSelectElement).value;
    await patchSettings({ model: next });
  }

  // Toggle uses bind:checked, so we react to mutations via $effect instead
  // of a DOM change handler. Skip the firing that happens on mount with
  // the initial value by comparing against the last-committed value.
  $effect(() => {
    if (watchdogRefork === priorWatchdog) return;
    void patchSettings({ watchdogRefork });
  });

  // FIX_FORWARD 6.3: nuke every auth:* rate-limit bucket. Gated since the
  // operator should explicitly acknowledge they're unlocking the sign-in
  // surface.
  async function resetAuthLimits() {
    const ok = await confirmDialog({
      title: "Clear auth rate-limits?",
      description:
        "Clear every auth rate-limit and lockout? Pending sign-in attempts will start from zero.",
      confirmLabel: "Clear",
      danger: true,
    });
    if (!ok) return;
    const r = await fetch("/api/settings/reset-auth-limits", {
      method: "POST",
    });
    if (r.ok) {
      const { cleared } = (await r.json()) as { cleared: number };
      alert(
        cleared > 0
          ? `Cleared ${cleared} rate-limit entr${cleared === 1 ? "y" : "ies"}.`
          : "No pending rate-limit entries to clear.",
      );
    }
  }

  async function signOut() {
    await fetch("/api/auth/sign-out", { method: "POST" });
    window.location.href = "/login";
  }

  /** FIX_FORWARD 5.11: revoke one session. If it's the current one, the
   *  next request will fail auth and the browser redirects to /login. */
  async function revokeSession(id: string, isCurrent: boolean) {
    await fetch("/api/sessions/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (isCurrent) {
      window.location.href = "/login";
      return;
    }
    await invalidateAll();
  }

  async function revokeAll() {
    const ok = await confirmDialog({
      title: "Sign out everywhere?",
      description:
        "Sign out every session, including this one? You'll need to log back in.",
      confirmLabel: "Sign out everywhere",
      danger: true,
    });
    if (!ok) return;
    await fetch("/api/sessions/revoke-all", { method: "POST" });
    window.location.href = "/login";
  }

  function fmtTimestamp(ms: number): string {
    return new Date(ms).toLocaleString();
  }

  /** Phase 6: human-readable bytes (MB / GB) for storage indicators.
   *  Browser storage quotas live in the GB range; usage typically sits
   *  in MB. Both surfaces are coarse — no need for KB / B detail. */
  function fmtBytes(bytes: number | null | undefined): string {
    if (!Number.isFinite(bytes ?? NaN) || (bytes ?? 0) <= 0) return "—";
    const b = bytes as number;
    const gb = b / (1024 ** 3);
    if (gb >= 0.5) return `${gb.toFixed(2)} GB`;
    const mb = b / (1024 ** 2);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    const kb = b / 1024;
    return `${kb.toFixed(1)} KB`;
  }

  function fmtStorageUsage(
    used: number | null | undefined,
    quota: number | null | undefined,
  ): string {
    const usedText = fmtBytes(used);
    if (!Number.isFinite(quota ?? NaN) || (quota ?? 0) <= 0) return usedText;
    return `${usedText} / ${fmtBytes(quota)}`;
  }

  /** Phase 6: forget a device. Hard-deletes the client_devices row
   *  via the `forgetDevice` mutator. When the user forgets the
   *  current tab, ALSO sign them out so the row doesn't get
   *  immediately re-created by the next `/api/sync/refresh` JWT
   *  mint. */
  async function forgetDevice(deviceId: string, isCurrent: boolean): Promise<void> {
    const ok = await confirmDialog({
      title: isCurrent ? "Forget this device?" : "Forget that device?",
      description: isCurrent
        ? "Removing this device's storage telemetry + per-device read cursors. You'll also be signed out — sign back in to re-register this device."
        : "Removing that device's storage telemetry + per-device read cursors. The device will re-register on next sync-refresh until it's signed out.",
      confirmLabel: "Forget device",
      danger: true,
    });
    if (!ok) return;
    zeroSync.forgetDevice(deviceId);
    if (isCurrent) {
      await fetch("/api/auth/sign-out", { method: "POST" });
      window.location.href = "/login";
    }
  }

  function shortenUserAgent(ua: string | null): string {
    if (!ua) return "unknown client";
    // Pick out a recognizable browser/platform fragment. Full UA strings
    // are unreadable; we want a one-line glance affordance.
    if (/CriOS|Chrome\//.test(ua)) {
      if (/iPhone|iPad/.test(ua)) return "Chrome · iOS";
      if (/Android/.test(ua)) return "Chrome · Android";
      if (/Mac OS X/.test(ua)) return "Chrome · macOS";
      if (/Windows/.test(ua)) return "Chrome · Windows";
      return "Chrome";
    }
    if (/Firefox\//.test(ua)) return "Firefox";
    if (/Safari\//.test(ua)) {
      if (/iPhone|iPad/.test(ua)) return "Safari · iOS";
      return "Safari · macOS";
    }
    if (/curl\//.test(ua)) return "curl";
    return ua.slice(0, 60);
  }
</script>

<header class="page-head">
  <h1>Settings</h1>
  <p class="page-lead">Account, theme, and configuration.</p>
</header>

<div class="grid">
  <div class="card">
    <div class="card-header"><h2>Account</h2></div>
    <div class="row">
      <span class="row-label">Email</span>
      <span class="row-value">{data.user.email}</span>
    </div>
    <div class="row">
      <span class="row-label">Name</span>
      <span class="row-value">{data.user.name}</span>
    </div>
    <div class="actions">
      <button class="ghost" onclick={signOut}>Sign out</button>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><h2>Theme</h2></div>
    <p class="row-value">
      Friday ships a warm sunrise palette and a cool moody night palette.
      Pick one, or follow your operating system. The choice is remembered
      across sessions and reachable from <kbd>⌘K</kbd> → Settings.
    </p>
    <div class="theme-picker" role="radiogroup" aria-label="Theme">
      <button
        type="button"
        class="theme-option"
        class:selected={selectedMode === "light"}
        aria-pressed={selectedMode === "light"}
        onclick={() => setMode("light")}>
        <span class="theme-icon" aria-hidden="true">
          <Sun size={16} strokeWidth={2} />
        </span>
        Light
      </button>
      <button
        type="button"
        class="theme-option"
        class:selected={selectedMode === "dark"}
        aria-pressed={selectedMode === "dark"}
        onclick={() => setMode("dark")}>
        <span class="theme-icon" aria-hidden="true">
          <Moon size={16} strokeWidth={2} />
        </span>
        Dark
      </button>
      <button
        type="button"
        class="theme-option"
        class:selected={selectedMode === "system"}
        aria-pressed={selectedMode === "system"}
        onclick={() => setMode("system")}>
        <span class="theme-icon" aria-hidden="true">
          <MonitorCog size={16} strokeWidth={2} />
        </span>
        System
      </button>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><h2>Model</h2></div>
    <p class="row-value">
      Default Claude model the daemon uses for new turns. Existing forked
      workers keep their current model until they exit.
    </p>
    <div class="actions">
      <select
        class="model-select"
        value={model}
        onchange={onModelChange}
        disabled={savingSettings}>
        {#each MODEL_OPTIONS as opt (opt.id)}
          <option value={opt.id}>{opt.label}</option>
        {/each}
      </select>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><h2>Apps</h2></div>
    <p class="row-value">
      Installed Friday Apps from <code>~/.friday/apps/</code>. Install,
      uninstall, and reload are CLI/MCP-only in v1 — this card is
      read-only.
    </p>
    {#if apps.length === 0}
      <p class="row-value muted">No apps installed.</p>
    {:else}
      <ul class="apps-list">
        {#each apps as app (app.id)}
          <li class="app-row">
            <div class="app-head">
              <span class="app-id">{app.id}</span>
              <span class="app-version">v{app.version}</span>
              <span class="app-status app-status-{app.status}">
                {app.status}
              </span>
            </div>
            <div class="app-name">{app.name}</div>
            {#if app.agents.length > 0}
              <div class="app-detail">
                <span class="muted">agents:</span>
                {app.agents.map((a) => a.name).join(", ")}
              </div>
            {/if}
            {#if app.schedules.length > 0}
              <div class="app-detail">
                <span class="muted">schedules:</span>
                {app.schedules
                  .map((s) => `${s.name} (${s.cron ?? "—"})`)
                  .join(", ")}
              </div>
            {/if}
            {#if app.mcpServers.length > 0}
              <div class="app-detail">
                <span class="muted">mcp:</span>
                {app.mcpServers.map((m) => m.name).join(", ")}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="card">
    <div class="card-header"><h2>Watchdog</h2></div>
    <p class="row-value">
      When an agent's worker process crashes mid-turn the watchdog can re-fork
      it automatically. Turn this off if you'd rather diagnose the cause by
      hand before letting Friday retry.
    </p>
    <div class="toggle-row">
      <Toggle
        bind:checked={watchdogRefork}
        label="Auto-refork crashed workers"
        disabled={savingSettings} />
    </div>
  </div>

  <div class="card">
    <div class="card-header"><h2>Keep screen awake</h2></div>
    <p class="row-value">
      Hold a screen wake lock while any agent is working so your phone won't
      sleep mid-turn. Default on for mobile, off for desktop. iOS Safari only
      honours this while the tab is foreground — it can't wake a locked
      phone.
    </p>
    <div class="toggle-row">
      <Toggle
        bind:checked={wakeLockEnabled}
        label="Keep screen awake while agents work"
        disabled={!wakeLockState.supported} />
    </div>
    {#if !wakeLockState.supported}
      <p class="row-value muted">
        This browser doesn't support the Screen Wake Lock API.
      </p>
    {:else if wakeLockState.held}
      <p class="row-value muted">Wake lock is active right now.</p>
    {/if}
  </div>

  <div class="card">
    <div class="card-header"><h2>Rate limits</h2></div>
    <p class="row-value">
      Sign-in attempts and password resets are rate-limited per IP and per
      email. Clear every <code>auth:*</code> bucket if you're locked out and
      can't wait for the window to expire.
    </p>
    <div class="actions">
      <button class="ghost danger" onclick={resetAuthLimits}>
        Reset auth rate-limits
      </button>
    </div>
  </div>

  {#if zeroOn}
    <div class="card devices-card">
      <div class="card-header"><h2>Devices</h2></div>
      <p class="row-value">
        Browser caches that have synced this account. Each row is a separate
        device-id minted by <code>/api/sync/refresh</code>. Forget a device to
        drop its read cursors + storage telemetry; the row is re-created the
        next time that browser refreshes its sync token.
      </p>
      {#if zeroSync.clientDevices.length === 0}
        <p class="row-value muted">No devices reported storage yet.</p>
      {:else}
        <ul class="device-list">
          {#each zeroSync.clientDevices as d (d.device_id)}
            {@const isCurrent = d.device_id === zeroSync.currentDeviceId}
            <li class="device-row" class:current={isCurrent}>
              <div class="device-meta">
                <span class="device-client">
                  {d.label ?? shortenUserAgent(d.user_agent ?? null)}
                </span>
                {#if isCurrent}
                  <span class="device-current">this device</span>
                {/if}
              </div>
              <div class="device-storage">
                <span class="storage-usage">
                  {fmtStorageUsage(d.storage_used_bytes, d.storage_quota_bytes)}
                </span>
                <span class="device-times">
                  Last seen {fmtTimestamp(d.last_seen_at)}
                </span>
              </div>
              <button
                class="ghost device-forget"
                onclick={() => forgetDevice(d.device_id, isCurrent)}>
                Forget this device
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  <div class="card sessions-card">
    <div class="card-header"><h2>Active sessions</h2></div>
    <p class="row-value">
      Devices and browsers currently signed in to this account. Revoke one to force
      that session to re-authenticate.
    </p>
    {#if data.sessions.length === 0}
      <p class="row-value muted">No active sessions.</p>
    {:else}
      <ul class="session-list">
        {#each data.sessions as s (s.id)}
          <li class="session-row" class:current={s.isCurrent}>
            <div class="session-meta">
              <span class="session-client">{shortenUserAgent(s.userAgent)}</span>
              {#if s.ipAddress}
                <span class="session-ip">{s.ipAddress}</span>
              {/if}
              {#if s.isCurrent}
                <span class="session-current">this device</span>
              {/if}
            </div>
            <div class="session-times">
              <span>Signed in {fmtTimestamp(s.createdAt)}</span>
              <span class="session-expires">Expires {fmtTimestamp(s.expiresAt)}</span>
            </div>
            <button
              class="ghost session-revoke"
              onclick={() => revokeSession(s.id, s.isCurrent)}>
              Revoke
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="actions">
      <button class="ghost danger" onclick={revokeAll}>Sign out all sessions</button>
    </div>
  </div>

  <div class="card config-card">
    <div class="card-header"><h2>Configuration</h2></div>
    <p class="row-value">
      Edit <code>~/.friday/config.json</code> directly to add MCP servers or override defaults.
    </p>
    <p class="row-value">
      Edit <code>~/.friday/SOUL.md</code> to customize Friday's voice and identity.
    </p>
  </div>
</div>

{#if settingsToast}
  <div
    class="settings-toast toast-{settingsToast.kind}"
    role="status"
    aria-live="polite">
    {settingsToast.msg}
  </div>
{/if}

<style>
  .row {
    display: flex;
    justify-content: space-between;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 0.9rem;
  }
  .row:last-of-type { border-bottom: none; }
  .row-label {
    color: var(--text-tertiary);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .row-value { color: var(--text-primary); margin: 0.5rem 0; }
  .row-value.muted { color: var(--text-tertiary); }
  .row-value code {
    background: var(--bg-code);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
  .actions {
    margin-top: 1rem;
    display: flex;
    gap: 0.5rem;
  }
  .config-card { grid-column: 1 / -1; }
  .sessions-card { grid-column: 1 / -1; }
  .devices-card { grid-column: 1 / -1; }
  .device-list {
    list-style: none;
    padding: 0;
    margin: 0.75rem 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .device-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 0.75rem;
    align-items: center;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-secondary);
  }
  .device-row.current {
    border-color: var(--accent-primary);
    background: var(--accent-glow);
  }
  .device-meta {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    min-width: 0;
  }
  .device-client {
    font-weight: 600;
    color: var(--text-primary);
    font-size: 0.85rem;
  }
  .device-current {
    font-size: 0.65rem;
    color: var(--accent-primary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    background: var(--bg-card);
    padding: 0.1rem 0.4rem;
    border-radius: 99px;
  }
  .device-storage {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.15rem;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-family: var(--font-mono);
  }
  .storage-usage { color: var(--text-primary); }
  .device-times { color: var(--text-tertiary); }
  .device-forget { font-size: 0.75rem; padding: 0.25rem 0.6rem; }
  @media (max-width: 640px) {
    .device-row { grid-template-columns: 1fr; }
    .device-storage { align-items: flex-start; }
  }

  .theme-picker {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .theme-option {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.8rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-secondary);
    color: var(--text-primary);
    cursor: pointer;
    font-size: 0.85rem;
  }
  .theme-option.selected {
    border-color: var(--accent-primary);
    background: var(--accent-glow);
  }
  .theme-icon {
    display: inline-flex;
    align-items: center;
    color: var(--text-secondary);
  }
  .theme-option.selected .theme-icon {
    color: var(--accent-primary);
  }

  .model-select {
    padding: 0.45rem 0.6rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    min-width: 280px;
  }
  .model-select:disabled { opacity: 0.6; }

  .toggle-row {
    display: inline-flex;
    align-items: center;
    margin-top: 0.75rem;
    font-size: 0.9rem;
    color: var(--text-primary);
  }

  .session-list {
    list-style: none;
    padding: 0;
    margin: 0.75rem 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .session-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 0.75rem;
    align-items: center;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-secondary);
  }
  .session-row.current {
    border-color: var(--accent-primary);
    background: var(--accent-glow);
  }
  .session-meta {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    min-width: 0;
  }
  .session-client {
    font-weight: 600;
    color: var(--text-primary);
    font-size: 0.85rem;
  }
  .session-ip {
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }
  .session-current {
    font-size: 0.65rem;
    color: var(--accent-primary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    background: var(--bg-card);
    padding: 0.1rem 0.4rem;
    border-radius: 99px;
  }
  .session-times {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.15rem;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-family: var(--font-mono);
  }
  .session-expires { color: var(--text-tertiary); }
  .session-revoke { font-size: 0.75rem; padding: 0.25rem 0.6rem; }

  @media (max-width: 640px) {
    .session-row {
      grid-template-columns: 1fr;
    }
    .session-times { align-items: flex-start; }
  }

  .settings-toast {
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
  .settings-toast.toast-ok { border-color: var(--status-success); }
  .settings-toast.toast-err {
    border-color: var(--status-error);
    color: var(--status-error);
  }

  .apps-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .app-row {
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-surface, var(--bg-card));
  }
  .app-head {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .app-id {
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .app-version {
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }
  .app-status {
    font-size: 0.7rem;
    padding: 0.1rem 0.5rem;
    border-radius: 99px;
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    text-transform: lowercase;
  }
  .app-status-installed { color: var(--status-success); }
  .app-status-orphaned { color: var(--text-tertiary); }
  .app-status-error { color: var(--status-error); }
  .app-name {
    margin-top: 0.2rem;
    color: var(--text-secondary);
    font-size: 0.85rem;
  }
  .app-detail {
    margin-top: 0.2rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
  .app-detail .muted {
    color: var(--text-tertiary);
    margin-right: 0.3rem;
  }
  .row-value.muted { color: var(--text-tertiary); }
</style>
