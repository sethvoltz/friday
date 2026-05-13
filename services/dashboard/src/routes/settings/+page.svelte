<script lang="ts">
  import type { PageData } from "./$types";
  import { invalidateAll } from "$app/navigation";
  import { KEYS, saveString, loadString } from "$lib/stores/persistent";
  import { onMount } from "svelte";
  let { data }: { data: PageData } = $props();

  // FIX_FORWARD 6.3: explicit theme selector. The header still has the
  // quick toggle; this widget surfaces and persists the choice.
  let theme = $state<"light" | "dark">("dark");
  onMount(() => {
    const stored = loadString(KEYS.theme);
    if (stored === "light" || stored === "dark") theme = stored;
    else if (document.documentElement.dataset.theme === "light")
      theme = "light";
  });
  function applyTheme(next: "light" | "dark") {
    theme = next;
    document.documentElement.dataset.theme = next;
    saveString(KEYS.theme, next);
  }

  // FIX_FORWARD 6.3: configurable Friday settings (model + watchdog).
  // PATCH writes back to ~/.friday/config.json via the dashboard's
  // /api/settings endpoint. The server snapshot seeds these once; user
  // edits are reflected locally from the PATCH response.
  // svelte-ignore state_referenced_locally
  let model = $state(data.settings.model);
  // svelte-ignore state_referenced_locally
  let watchdogRefork = $state(data.settings.watchdogRefork);
  let savingSettings = $state(false);

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

  async function patchSettings(body: Record<string, unknown>) {
    savingSettings = true;
    try {
      let r: Response;
      try {
        r = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (err) {
        // Network failed entirely — revert and surface so the user
        // doesn't see a control sitting on the failed value.
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
      // Config is written to disk, but the running daemon caches its
      // config at boot — these changes take effect for the next daemon
      // start, not the next turn.
      showSettingsToast("saved · restart daemon for changes to take effect", "ok");
    } finally {
      savingSettings = false;
    }
  }

  async function onModelChange(e: Event) {
    const next = (e.target as HTMLSelectElement).value;
    await patchSettings({ model: next });
  }

  async function onWatchdogChange(e: Event) {
    const next = (e.target as HTMLInputElement).checked;
    await patchSettings({ watchdogRefork: next });
  }

  // FIX_FORWARD 6.3: nuke every auth:* rate-limit bucket. Gated by a
  // confirm() since the operator should explicitly acknowledge they're
  // unlocking the sign-in surface.
  async function resetAuthLimits() {
    if (
      !confirm(
        "Clear every auth rate-limit and lockout? Pending sign-in attempts will start from zero.",
      )
    )
      return;
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
    if (
      !confirm(
        "Sign out every session, including this one? You'll need to log back in.",
      )
    )
      return;
    await fetch("/api/sessions/revoke-all", { method: "POST" });
    window.location.href = "/login";
  }

  function fmtTimestamp(ms: number): string {
    return new Date(ms).toLocaleString();
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
      Friday ships a warm sunrise palette and a cool moody night palette. The
      header has a quick toggle; pick one here and we'll remember it across
      sessions.
    </p>
    <div class="theme-picker" role="radiogroup" aria-label="Theme">
      <button
        type="button"
        class="theme-option"
        class:selected={theme === "light"}
        aria-pressed={theme === "light"}
        onclick={() => applyTheme("light")}>
        <span class="theme-swatch swatch-light"></span>
        Light
      </button>
      <button
        type="button"
        class="theme-option"
        class:selected={theme === "dark"}
        aria-pressed={theme === "dark"}
        onclick={() => applyTheme("dark")}>
        <span class="theme-swatch swatch-dark"></span>
        Dark
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
    <div class="card-header"><h2>Watchdog</h2></div>
    <p class="row-value">
      When an agent's worker process crashes mid-turn the watchdog can re-fork
      it automatically. Turn this off if you'd rather diagnose the cause by
      hand before letting Friday retry.
    </p>
    <label class="toggle-row">
      <input
        type="checkbox"
        checked={watchdogRefork}
        onchange={onWatchdogChange}
        disabled={savingSettings} />
      <span>Auto-refork crashed workers</span>
    </label>
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
  .theme-swatch {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px solid var(--border-subtle);
  }
  .swatch-light {
    background: linear-gradient(135deg, #fff4e0 0%, #ffd28a 100%);
  }
  .swatch-dark {
    background: linear-gradient(135deg, #1c1f26 0%, #2a2f3a 100%);
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
    gap: 0.5rem;
    margin-top: 0.75rem;
    font-size: 0.9rem;
    color: var(--text-primary);
    cursor: pointer;
  }
  .toggle-row input[type="checkbox"] { cursor: pointer; }
  .toggle-row input[type="checkbox"]:disabled { cursor: default; }

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
  button.danger { color: var(--status-error); }

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
</style>
