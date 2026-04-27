<script lang="ts">
  import '../app.css';
  import favicon from '$lib/assets/favicon.svg';
  import { connectSSE, disconnectSSE, getConnection } from '$lib/events.svelte';
  import { onMount } from 'svelte';

  import { page } from '$app/stores';

  let { data, children } = $props();

  let theme = $state<'light' | 'dark'>('dark');

  $effect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  });

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
  }

  onMount(() => {
    connectSSE(data.eventServerUrl);
    return () => disconnectSSE();
  });

  const connection = $derived(getConnection());

  // Live uptime ticker
  let uptimeMs = $state(data.health ? Date.now() - new Date(data.health.startedAt).getTime() : 0);
  onMount(() => {
    const interval = setInterval(() => {
      if (data.health) {
        uptimeMs = Date.now() - new Date(data.health.startedAt).getTime();
      }
    }, 1000);
    return () => clearInterval(interval);
  });

  function fmtDuration(ms: number) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m ${rs}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
</svelte:head>

<div data-theme={theme} class="app-shell">
  <header class="app-header">
    <div class="header-left">
      <h1 class="logo">
        <span class="logo-icon">F</span>
        <span>Friday</span>
      </h1>
      <span class="header-sep"></span>
      <div class="header-status">
        <span class="pulse" class:offline={!data.daemonOnline}></span>
        <span class="header-status-text">
          Bot
          {#if data.daemonOnline}
            {#if data.health}
              &middot; PID {data.health.pid} &middot; up {fmtDuration(uptimeMs)}
            {/if}
          {:else}
            &middot; offline
          {/if}
        </span>
        <span class="header-sep"></span>
        <span class="pulse" class:offline={!connection.connected}></span>
        <span class="header-status-text">
          Live
          {#if !connection.connected}
            &middot; disconnected
          {/if}
        </span>
      </div>
    </div>
    <div class="header-right">
      <span class="badge" class:ok={data.configExists} class:warn={!data.configExists}>
        {data.configExists ? 'Config loaded' : 'Using defaults'}
      </span>
      <nav class="header-nav">
        <a href="/" class:active={$page.url.pathname === '/'}>Dashboard</a>
        <a href="/sessions" class:active={$page.url.pathname.startsWith('/sessions')}>Sessions</a>
        <a href="/schedules" class:active={$page.url.pathname.startsWith('/schedules')}>Schedules</a>
        <a href="/memory" class:active={$page.url.pathname.startsWith('/memory')}>Memory</a>
        <a href="/evolve" class:active={$page.url.pathname.startsWith('/evolve')}>Evolve</a>
      </nav>
      <button class="theme-toggle" onclick={toggleTheme} title="Toggle theme">
        {theme === 'dark' ? '☀' : '☾'}
      </button>
    </div>
  </header>

  <main class="app-main">
    {@render children()}
  </main>
</div>

<style>
  .app-shell {
    min-height: 100vh;
    background: var(--bg-primary);
    transition: background var(--transition-normal);
  }

  .app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1.5rem;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
    position: sticky;
    top: 0;
    z-index: 10;
    backdrop-filter: blur(8px);
    gap: 1rem;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 1.1rem;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: var(--text-primary);
    flex-shrink: 0;
  }

  .logo-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.7rem;
    height: 1.7rem;
    border-radius: var(--radius-sm);
    background: var(--accent-primary);
    color: var(--text-inverse);
    font-family: var(--font-mono);
    font-size: 0.9rem;
    font-weight: 700;
  }

  .header-sep {
    width: 1px;
    height: 1.2rem;
    background: var(--border-primary);
    flex-shrink: 0;
  }

  .header-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .header-status-text {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .header-nav {
    display: flex;
    gap: 0.25rem;
  }

  .header-nav a {
    padding: 0.35rem 0.75rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text-secondary);
    text-decoration: none;
    border-radius: var(--radius-sm);
    transition: all var(--transition-fast);
  }

  .header-nav a:hover {
    color: var(--text-primary);
    background: var(--bg-tertiary);
  }

  .header-nav a.active {
    color: var(--accent-primary);
    background: var(--accent-glow);
  }

  .app-main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1.5rem;
  }
</style>
