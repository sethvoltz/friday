<script lang="ts">
  import { onMount } from "svelte";

  interface Cmd { name: string; description: string; source?: string; destructive?: boolean }
  interface CommandsResponse { system: Cmd[]; skills: Cmd[] }
  let data = $state<CommandsResponse>({ system: [], skills: [] });

  onMount(() => {
    void fetch("/api/commands")
      .then((r) => r.json())
      .then((c: CommandsResponse) => (data = c));
  });
</script>

<header class="page-head">
  <h1>Skills &amp; Commands</h1>
  <p class="page-lead">Slash commands available in the chat input.</p>
</header>

<div class="card">
  <div class="card-header">
    <h2>System commands</h2>
    <span class="stat-detail">{data.system.length}</span>
  </div>
  <table class="data-table">
    <thead>
      <tr><th>Command</th><th>Description</th></tr>
    </thead>
    <tbody>
      {#each data.system as c}
        <tr>
          <td>
            <code class="cmd">/{c.name}</code>
            {#if c.destructive}
              <span class="badge warn">destructive</span>
            {/if}
          </td>
          <td>{c.description}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<div class="card">
  <div class="card-header">
    <h2>Skills</h2>
    <span class="stat-detail">{data.skills.length}</span>
  </div>
  {#if data.skills.length === 0}
    <p class="empty-state">
      No skills loaded. Drop markdown files in <code>~/.friday/skills/</code> to add your own.
    </p>
  {:else}
    <table class="data-table">
      <thead>
        <tr><th>Skill</th><th>Description</th><th>Source</th></tr>
      </thead>
      <tbody>
        {#each data.skills as s}
          <tr>
            <td><code class="cmd">/{s.name}</code></td>
            <td>{s.description}</td>
            <td class="text-muted">{s.source}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .cmd {
    background: var(--bg-code);
    color: var(--accent-primary);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    font-family: var(--font-mono);
  }
  .text-muted { color: var(--text-tertiary); font-size: 0.8rem; }
</style>
