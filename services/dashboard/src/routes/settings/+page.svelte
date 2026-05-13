<script lang="ts">
  import type { PageData } from "./$types";
  import { invalidateAll } from "$app/navigation";
  let { data }: { data: PageData } = $props();

  async function signOut() {
    await fetch("/api/auth/sign-out", { method: "POST" });
    window.location.href = "/login";
  }

  function toggleTheme() {
    const cur = document.documentElement.dataset.theme ?? "dark";
    document.documentElement.dataset.theme = cur === "dark" ? "light" : "dark";
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
    <p class="row-value">Toggle between Friday's warm sunrise (light) and cool moody night (dark) palettes.</p>
    <div class="actions">
      <button class="ghost" onclick={toggleTheme}>Toggle theme</button>
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
</style>
