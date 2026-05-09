<script lang="ts">
  import type { PageData } from "./$types";
  let { data }: { data: PageData } = $props();

  async function signOut() {
    await fetch("/api/auth/sign-out", { method: "POST" });
    window.location.href = "/login";
  }

  function toggleTheme() {
    const cur = document.documentElement.dataset.theme ?? "dark";
    document.documentElement.dataset.theme = cur === "dark" ? "light" : "dark";
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
</style>
