<script lang="ts">
  import "../app.css";
  import favicon from "$lib/assets/favicon.svg";
  import avatar from "$lib/assets/avatar.png";
  import { page } from "$app/stores";
  import { onMount } from "svelte";
  import { sseConnected, startSSE, stopSSE } from "$lib/stores/sse.svelte";
  import { KEYS, loadString, saveString } from "$lib/stores/persistent";
  import { sendQueue } from "$lib/stores/send-queue.svelte";
  import { chat } from "$lib/stores/chat.svelte";
  import type { LayoutData } from "./$types";
  import type { Snippet } from "svelte";

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  let theme = $state<"light" | "dark">("dark");
  // Restore theme from localStorage on mount (after $state is set up so the
  // initial render uses the persisted value before $effect fires).
  if (typeof document !== "undefined") {
    const stored = loadString(KEYS.theme);
    if (stored === "light" || stored === "dark") theme = stored;
  }
  $effect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    saveString(KEYS.theme, theme);
  });

  // Flush the optimistic-send queue every time SSE reconnects. The queue
  // itself is idempotent (in-flight POST is guarded by `flushing`), so
  // multiple triggers in quick succession are safe.
  let lastConnected = $state(false);
  $effect(() => {
    const c = sseConnected.value;
    if (c && !lastConnected && sendQueue.items.length > 0) {
      void sendQueue.flush().then((sent) => {
        for (const s of sent) {
          chat.clearQueueMarker(s.queueId);
          chat.inflightTurnId = s.turnId;
        }
      });
    }
    lastConnected = c;
  });
  function toggleTheme() {
    theme = theme === "dark" ? "light" : "dark";
  }

  let menuOpen = $state(false);
  function closeMenu() {
    menuOpen = false;
  }

  let isLogin = $derived($page.url.pathname.startsWith("/login"));
  let isChat = $derived(
    $page.url.pathname === "/" ||
      /^\/sessions\/[^/]+(\/[^/]+)?\/?$/.test($page.url.pathname),
  );
  let signedIn = $derived(!!data.user);

  // Live uptime ticker + global SSE connection (one EventSource for all pages)
  let uptimeMs = $state(0);
  onMount(() => {
    if (data.health?.uptimeSec !== undefined) {
      uptimeMs = data.health.uptimeSec * 1000;
    }
    const i = setInterval(() => {
      if (data.daemonOnline) uptimeMs += 1000;
    }, 1000);
    if (signedIn && !isLogin) startSSE();

    // Best-effort flush on initial mount — drains anything left in
    // localStorage from a previous session that ended offline.
    if (signedIn && !isLogin && sendQueue.items.length > 0) {
      void sendQueue.flush().then((sent) => {
        for (const s of sent) {
          chat.clearQueueMarker(s.queueId);
          chat.inflightTurnId = s.turnId;
        }
      });
    }

    // Mobile keyboard handling: when the soft keyboard opens, iOS Safari
    // scrolls the visual viewport up inside the layout viewport, which
    // drags `position: fixed` elements (the floating header, in
    // particular) out of view. Track visualViewport.offsetTop in a CSS
    // var so the header can stay anchored to the *visible* top edge.
    const vv = window.visualViewport;
    let vvUpdate: (() => void) | undefined;
    if (vv) {
      vvUpdate = () => {
        document.documentElement.style.setProperty(
          "--vv-offset-top",
          `${vv.offsetTop}px`,
        );
      };
      vvUpdate();
      vv.addEventListener("resize", vvUpdate);
      vv.addEventListener("scroll", vvUpdate);
    }

    return () => {
      clearInterval(i);
      stopSSE();
      if (vv && vvUpdate) {
        vv.removeEventListener("resize", vvUpdate);
        vv.removeEventListener("scroll", vvUpdate);
      }
    };
  });
  // Offline banner: only show after the SSE has been disconnected for a few
  // seconds, so a momentary blip during reconnect doesn't flash a banner.
  let showOfflineBanner = $state(false);
  $effect(() => {
    if (sseConnected.value) {
      showOfflineBanner = false;
      return;
    }
    const t = setTimeout(() => {
      if (!sseConnected.value) showOfflineBanner = true;
    }, 5000);
    return () => clearTimeout(t);
  });
  function fmtDuration(ms: number) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link
    rel="preconnect"
    href="https://fonts.gstatic.com"
    crossorigin="anonymous" />
  <link
    href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
    rel="stylesheet" />
</svelte:head>

<div data-theme={theme} class="app-shell">
  {#if signedIn && !isLogin && showOfflineBanner}
    <div class="offline-banner" role="status" aria-live="polite">
      Daemon unreachable — retrying. Sent messages are queued and will flush on reconnect.
    </div>
  {/if}
  {#if signedIn && !isLogin}
    <header class="app-header">
      <div class="header-left">
        <a href="/" class="logo" onclick={closeMenu}>
          <img class="logo-icon" src={avatar} alt="Friday" />
          <span>Friday</span>
        </a>
        <span class="header-sep"></span>
        <div class="header-status">
          <span class="pulse" class:offline={!data.daemonOnline}></span>
          <span class="header-status-text desktop-status">
            Bot
            {#if data.daemonOnline && data.health}
              &middot; PID {data.health.pid} &middot; up {fmtDuration(uptimeMs)}
            {:else if !data.daemonOnline}
              &middot; offline
            {/if}
          </span>
          <span class="header-status-label mobile-status">B</span>
          <span class="header-sep"></span>
          <span class="pulse" class:offline={!sseConnected.value}></span>
          <span class="header-status-text desktop-status">
            Live{#if !sseConnected.value} &middot; disconnected{/if}
          </span>
          <span class="header-status-label mobile-status">L</span>
        </div>
      </div>
      <div class="header-right">
        <nav class="header-nav" class:open={menuOpen}>
          <a
            href="/"
            class:active={$page.url.pathname === "/" ||
              $page.url.pathname.startsWith("/sessions")}
            onclick={closeMenu}>Chat</a>
          <a href="/dashboard" class:active={$page.url.pathname.startsWith("/dashboard")} onclick={closeMenu}>Dashboard</a>
          <a href="/tickets" class:active={$page.url.pathname.startsWith("/tickets")} onclick={closeMenu}>Tickets</a>
          <a href="/schedules" class:active={$page.url.pathname.startsWith("/schedules")} onclick={closeMenu}>Schedules</a>
          <a href="/memory" class:active={$page.url.pathname.startsWith("/memory")} onclick={closeMenu}>Memory</a>
          <a href="/evolve" class:active={$page.url.pathname.startsWith("/evolve")} onclick={closeMenu}>Evolve</a>
          <a href="/skills" class:active={$page.url.pathname.startsWith("/skills")} onclick={closeMenu}>Skills</a>
          <a href="/logs" class:active={$page.url.pathname.startsWith("/logs")} onclick={closeMenu}>Logs</a>
          <a href="/settings" class:active={$page.url.pathname.startsWith("/settings")} onclick={closeMenu}>Settings</a>
        </nav>
        <button class="theme-toggle" onclick={toggleTheme} title="Toggle theme" aria-label="Toggle theme">
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <button class="hamburger-btn" onclick={() => (menuOpen = !menuOpen)} aria-label="Toggle navigation">
          <span></span><span></span><span></span>
        </button>
      </div>
    </header>
  {/if}

  <main class="app-main" class:no-header={!signedIn || isLogin} class:chat-route={isChat && signedIn && !isLogin}>
    {@render children()}
  </main>
</div>

<style>
  .app-shell {
    min-height: 100vh;
    background: var(--bg-primary);
    transition: background var(--transition-normal);
  }

  .offline-banner {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 300;
    padding: 0.5rem 1rem;
    text-align: center;
    background: var(--status-warn, #b45309);
    color: var(--text-inverse, #fff);
    font-size: 0.8rem;
    font-weight: 500;
  }

  .app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1.5rem;
    border: 1px solid var(--border-subtle);
    background: var(--header-float-bg);
    position: fixed;
    /* --vv-offset-top is set from visualViewport in +layout.svelte and
       keeps the header pinned to the top of the *visible* viewport when
       the mobile keyboard is open. Defaults to 0 on desktop. */
    top: calc(1rem + var(--vv-offset-top, 0px));
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

  .header-left { display: flex; align-items: center; gap: 0.75rem; min-width: 0; }
  .header-right { display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0; position: relative; }

  .header-sep { width: 1px; height: 1.2rem; background: var(--border-primary); flex-shrink: 0; }
  .header-status { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
  .header-status-text {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .header-status-label {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .mobile-status { display: none; }

  .logo {
    display: flex; align-items: center; gap: 0.5rem;
    font-size: 1.1rem; font-weight: 700; letter-spacing: -0.03em;
    color: var(--text-primary); flex-shrink: 0; text-decoration: none;
    transition: opacity var(--transition-fast);
  }
  .logo:hover { opacity: 0.8; }
  .logo-icon { width: 1.7rem; height: 1.7rem; border-radius: var(--radius-sm); object-fit: cover; flex-shrink: 0; }

  .header-nav { display: flex; gap: 0.25rem; }
  .header-nav a {
    padding: 0.35rem 0.75rem; font-size: 0.8rem; font-weight: 500;
    color: var(--text-secondary); text-decoration: none;
    border-radius: var(--radius-sm); transition: all var(--transition-fast);
  }
  .header-nav a:hover { color: var(--text-primary); background: var(--bg-tertiary); }
  .header-nav a.active { color: var(--accent-primary); background: var(--accent-glow); }

  .app-main { max-width: 1200px; margin: 0 auto; padding: 1.5rem; padding-top: 5.5rem; }
  .app-main.no-header { padding-top: 1.5rem; max-width: none; padding: 0; }
  .app-main.chat-route { max-width: none; margin: 0; padding: 0; }

  .hamburger-btn {
    display: none; flex-direction: column; justify-content: center; gap: 4px;
    background: none; border: none; cursor: pointer; padding: 0.25rem; flex-shrink: 0;
  }
  .hamburger-btn span {
    display: block; width: 1.25rem; height: 2px; background: var(--text-primary);
    border-radius: 2px; transition: background var(--transition-fast);
  }
  .hamburger-btn:hover span { background: var(--accent-primary); }

  @media (max-width: 1100px) {
    .header-nav {
      display: none;
      position: absolute; top: calc(100% + 0.5rem); right: 0;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
      padding: 0.375rem; flex-direction: column; min-width: 11rem; z-index: 200;
    }
    .header-nav.open { display: flex; }
    .header-nav a { padding: 0.6rem 1rem; font-size: 0.875rem; border-radius: var(--radius-sm); }
    .hamburger-btn { display: flex; }
  }

  @media (max-width: 640px) {
    .app-header { border-radius: var(--radius-lg); }
    .app-main { padding: 1rem; padding-top: 5rem; }
    .desktop-status { display: none; }
    .mobile-status { display: inline; }
  }
</style>
