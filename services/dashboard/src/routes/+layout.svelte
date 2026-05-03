<script lang="ts">
  import '../app.css';
  import favicon from '$lib/assets/favicon.svg';
  import avatar from '$lib/assets/avatar.png';
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
  let uptimeMs = $state(0);
  onMount(() => {
    if (data.health) uptimeMs = Date.now() - new Date(data.health.startedAt).getTime();
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

  let menuOpen = $state(false);
  function closeMenu() { menuOpen = false; }
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
      <a href="/" class="logo">
        <img class="logo-icon" src={avatar} alt="Friday" />
        <span>Friday</span>
      </a>
      <span class="header-sep"></span>
      <div class="header-status">
        <span class="pulse" class:offline={!data.daemonOnline}></span>
        <span class="header-status-text desktop-status">
          Bot
          {#if data.daemonOnline}
            {#if data.health}
              &middot; PID {data.health.pid} &middot; up {fmtDuration(uptimeMs)}
            {/if}
          {:else}
            &middot; offline
          {/if}
        </span>
        <span class="header-status-label mobile-status">B</span>
        <span class="header-sep"></span>
        <span class="pulse" class:offline={!connection.connected}></span>
        <span class="header-status-text desktop-status">
          Live
          {#if !connection.connected}
            &middot; disconnected
          {/if}
        </span>
        <span class="header-status-label mobile-status">L</span>
      </div>
    </div>
    <div class="header-right">
      <span class="badge config-badge" class:ok={data.configExists} class:warn={!data.configExists}>
        {data.configExists ? 'Config loaded' : 'Using defaults'}
      </span>
      <nav class="header-nav" class:open={menuOpen}>
        <a href="/" class:active={$page.url.pathname === '/'} onclick={closeMenu}>Dashboard</a>
        <a href="/sessions" class:active={$page.url.pathname.startsWith('/sessions')} onclick={closeMenu}>Sessions</a>
        <a href="/schedules" class:active={$page.url.pathname.startsWith('/schedules')} onclick={closeMenu}>Schedules</a>
        <a href="/memory" class:active={$page.url.pathname.startsWith('/memory')} onclick={closeMenu}>Memory</a>
        <a href="/evolve" class:active={$page.url.pathname.startsWith('/evolve')} onclick={closeMenu}>Evolve</a>
      </nav>
      <button class="theme-toggle" onclick={toggleTheme} title="Toggle theme">
        {theme === 'dark' ? '☀' : '☾'}
      </button>
      <button class="hamburger-btn" onclick={() => menuOpen = !menuOpen} aria-label="Toggle navigation">
        <span></span>
        <span></span>
        <span></span>
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
    border: 1px solid var(--border-subtle);
    background: var(--header-float-bg);
    position: fixed;
    top: 1rem;
    left: 50%;
    transform: translateX(-50%);
    width: calc(100% - 2rem);
    max-width: 1260px;
    z-index: 100;
    backdrop-filter: blur(20px) saturate(160%);
    -webkit-backdrop-filter: blur(20px) saturate(160%);
    border-radius: 999px;
    box-shadow: var(--shadow-lg);
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
    position: relative;
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
    text-decoration: none;
    transition: opacity var(--transition-fast);
  }

  .logo:hover {
    opacity: 0.8;
  }

  .logo-icon {
    width: 1.7rem;
    height: 1.7rem;
    border-radius: var(--radius-sm);
    object-fit: cover;
    flex-shrink: 0;
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
    padding-top: 5.5rem;
  }

  .header-status-label {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .mobile-status { display: none; }

  .hamburger-btn {
    display: none;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    flex-shrink: 0;
  }

  .hamburger-btn span {
    display: block;
    width: 1.25rem;
    height: 2px;
    background: var(--text-primary);
    border-radius: 2px;
    transition: background var(--transition-fast);
  }

  .hamburger-btn:hover span {
    background: var(--accent-primary);
  }

  @media (max-width: 640px) {
    .app-header {
      border-radius: var(--radius-lg);
    }

    .desktop-status { display: none; }
    .mobile-status { display: inline; }
    .config-badge { display: none; }
    .hamburger-btn { display: flex; }

    .header-nav {
      display: none;
      position: absolute;
      top: calc(100% + 0.5rem);
      right: 0;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-lg);
      padding: 0.375rem;
      flex-direction: column;
      min-width: 11rem;
      z-index: 200;
    }

    .header-nav.open {
      display: flex;
    }

    .header-nav a {
      padding: 0.6rem 1rem;
      font-size: 0.875rem;
      border-radius: var(--radius-sm);
    }

    .app-main {
      padding: 1rem;
      padding-top: 5rem;
    }
  }
</style>
