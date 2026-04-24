<script lang="ts">
  import '../app.css';
  import favicon from '$lib/assets/favicon.svg';

  import { page } from '$app/stores';

  let { children } = $props();

  let theme = $state<'light' | 'dark'>('dark');

  $effect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  });

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
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
    </div>
    <nav class="header-nav">
      <a href="/" class:active={$page.url.pathname === '/'}>Dashboard</a>
      <a href="/sessions" class:active={$page.url.pathname.startsWith('/sessions')}>Sessions</a>
    </nav>
    <div class="header-right">
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
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 1.1rem;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: var(--text-primary);
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
