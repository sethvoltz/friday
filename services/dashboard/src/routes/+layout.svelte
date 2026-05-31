<script lang="ts">
  import "../app.css";
  import favicon from "$lib/assets/favicon.svg";
  import avatar from "$lib/assets/avatar.png";
  import { page } from "$app/stores";
  import { onMount } from "svelte";
  import { sseConnected, startSSE, stopSSE } from "$lib/stores/sse.svelte";
  import { startConnectivity } from "$lib/stores/connectivity.svelte";
  import {
    startWakeLock,
    stopWakeLock,
    wakeLockState,
  } from "$lib/stores/wake-lock.svelte";
  import ConnectivityWidget from "$lib/components/Connectivity/ConnectivityWidget.svelte";
  import SyncOverlay from "$lib/components/SyncOverlay/SyncOverlay.svelte";
  import { Coffee, MessagesSquare } from "lucide-svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog/ConfirmDialog.svelte";
  import CommandPalette from "$lib/components/CommandPalette/CommandPalette.svelte";
  import { commandPalette } from "$lib/components/CommandPalette/store.svelte";
  import { bindTheme } from "$lib/stores/theme.svelte";
  import { zeroSync } from "$lib/stores/zero.svelte";
  import { FOUC_SCRIPT } from "$lib/theme/foucScript";
  import type { LayoutData } from "./$types";
  import type { Snippet } from "svelte";

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  // FRI-124: Friday's theming runtime is in-tree. FOUC_SCRIPT (injected
  // via <svelte:head> below) reads localStorage['friday:theme'] and
  // stamps the resolved .palette-<name> + .dark classes on <html>
  // synchronously before first paint. bindTheme(zeroSync) wires the
  // runtime store to Zero's canonical settings row, the system's
  // prefers-color-scheme signal, and DOM side effects (palette class,
  // colorScheme, theme-color meta, localStorage write-through). See
  // lib/stores/theme.svelte.ts and lib/theme/foucScript.ts.

  let menuOpen = $state(false);
  function closeMenu() {
    menuOpen = false;
  }

  // Priority+ header navigation. Links overflow one-by-one into a "More"
  // menu as the header narrows, replacing the old all-or-nothing CSS
  // breakpoint that dumped every link into the hamburger at 1100px.
  //
  // Stability (the hard part): the available-width measurement observes
  // `.header-right`, whose box width is the flex *leftover* after the
  // content-stable `header-left`. It does NOT depend on how many links are
  // currently visible — moving a link into More doesn't change it. That
  // severs the classic priority+ feedback loop (hide a link → container
  // grows → link reappears → bounce), so `visibleCount` is a pure function
  // of a measurement that never moves when links shuffle buckets.
  interface NavLink {
    href: string;
    label: string;
    match: (p: string) => boolean;
  }
  const navLinks: NavLink[] = [
    {
      href: "/",
      label: "Chat",
      match: (p) => p === "/" || p.startsWith("/sessions"),
    },
    {
      href: "/dashboard",
      label: "Dashboard",
      match: (p) => p.startsWith("/dashboard"),
    },
    { href: "/tickets", label: "Tickets", match: (p) => p.startsWith("/tickets") },
    {
      href: "/schedules",
      label: "Schedules",
      match: (p) => p.startsWith("/schedules"),
    },
    { href: "/memory", label: "Memory", match: (p) => p.startsWith("/memory") },
    { href: "/evolve", label: "Evolve", match: (p) => p.startsWith("/evolve") },
    { href: "/skills", label: "Skills", match: (p) => p.startsWith("/skills") },
    { href: "/logs", label: "Logs", match: (p) => p.startsWith("/logs") },
    {
      href: "/settings",
      label: "Settings",
      match: (p) => p.startsWith("/settings"),
    },
  ];

  // Gaps mirror the CSS: `.header-nav` uses 0.25rem between links, and
  // `.header-right` uses 0.75rem between the nav, the ⌘K chip, and More.
  const NAV_GAP = 4;
  const CLUSTER_GAP = 12;

  let headerRightRef: HTMLElement | undefined = $state();
  let ghostNavRef: HTMLElement | undefined = $state();
  let cmdkRef: HTMLElement | undefined = $state();
  let navMoreRef: HTMLElement | undefined = $state();

  let availWidth = $state(0); // header-right content width (overflow-invariant)
  let linkWidths = $state<number[]>([]); // per-link intrinsic widths (ghost-measured)
  let moreWidth = $state(0); // intrinsic width of the More button
  let cmdkWidth = $state(0); // live width of the ⌘K chip (0 when hidden)

  // Read every measurement and the available width, writing each `$state`
  // ONLY when its value actually changed. The change-guards matter: an
  // unconditional `linkWidths = [...]` allocates a fresh array every tick,
  // which re-renders the nav even when nothing moved — exactly the kind of
  // redundant churn that makes a ResizeObserver re-fire and trips the
  // browser's "loop completed with undelivered notifications" heuristic.
  function syncNav() {
    const ghost = ghostNavRef;
    if (ghost) {
      const links = ghost.querySelectorAll<HTMLElement>("[data-ghost-link]");
      const next = [...links].map((el) => el.offsetWidth);
      if (
        next.length !== linkWidths.length ||
        next.some((w, i) => w !== linkWidths[i])
      ) {
        linkWidths = next;
      }
      const more = ghost.querySelector<HTMLElement>("[data-ghost-more]");
      const mw = more ? more.offsetWidth : 0;
      if (mw !== moreWidth) moreWidth = mw;
    }
    const cw = cmdkRef?.offsetWidth ?? 0;
    if (cw !== cmdkWidth) cmdkWidth = cw;
    const aw = headerRightRef?.clientWidth ?? 0;
    if (aw !== availWidth) availWidth = aw;
  }

  // How many links fit before we must start overflowing into More. Pure
  // function of `availWidth` + cached widths → no resize feedback loop.
  let visibleCount = $derived.by(() => {
    if (availWidth === 0 || linkWidths.length !== navLinks.length) {
      return navLinks.length;
    }
    const cmdkCost = cmdkWidth > 0 ? cmdkWidth + CLUSTER_GAP : 0;
    const budget = availWidth - cmdkCost;

    // Everything fits with no More button? Show it all (no reserve needed).
    let sumAll = 0;
    for (let i = 0; i < navLinks.length; i++) {
      sumAll += linkWidths[i] + (i > 0 ? NAV_GAP : 0);
    }
    if (sumAll <= budget) return navLinks.length;

    // Otherwise a More button is guaranteed — permanently reserve its width
    // and greedily fit links to its left. Reserving unconditionally here is
    // what keeps the 0↔1 overflow boundary from oscillating.
    const moreCost = moreWidth + CLUSTER_GAP;
    let used = 0;
    for (let i = 0; i < navLinks.length; i++) {
      const cost = linkWidths[i] + (i > 0 ? NAV_GAP : 0);
      if (used + cost + moreCost > budget) return i;
      used += cost;
    }
    return navLinks.length;
  });

  let visibleLinks = $derived(navLinks.slice(0, visibleCount));
  let overflowLinks = $derived(navLinks.slice(visibleCount));

  // Wire the measurement once the signed-in header (and its ghost) mount.
  $effect(() => {
    const hr = headerRightRef;
    const ghost = ghostNavRef;
    if (!hr || !ghost) return;

    syncNav();

    // One observer over both targets (the flex track `.header-right` and the
    // measuring ghost, which re-lays-out when the webfont swaps in), coalesced
    // into a single rAF. Deferring the state write out of the RO delivery
    // cycle — plus the change-guards in syncNav — keeps the benign
    // "ResizeObserver loop" warning from firing during layout settling.
    let rafId = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(syncNav);
    });
    ro.observe(hr);
    ro.observe(ghost);

    // The ⌘K chip is hidden below 640px; that toggle doesn't resize
    // header-right (its box is flex leftover), so re-measure on the change.
    const narrow = window.matchMedia("(max-width: 640px)");
    const onNarrow = () => syncNav();
    narrow.addEventListener("change", onNarrow);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      narrow.removeEventListener("change", onNarrow);
    };
  });

  // Close the More menu on outside-click / Escape.
  $effect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (navMoreRef && !navMoreRef.contains(e.target as Node)) menuOpen = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") menuOpen = false;
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  });

  let isLogin = $derived($page.url.pathname.startsWith("/login"));
  let isChat = $derived(
    $page.url.pathname === "/" ||
      /^\/sessions\/[^/]+(\/[^/]+)?\/?$/.test($page.url.pathname),
  );
  let signedIn = $derived(!!data.user);

  // Live uptime ticker + global SSE connection (one EventSource for all pages)
  let uptimeMs = $state(0);
  onMount(() => {
    // FRI-124: bind the runtime theme store to Zero + matchMedia + DOM.
    // The FOUC script has already stamped a palette class on <html> by
    // the time we reach this point; the binder reconciles with the
    // canonical Zero row once it hydrates and re-applies side effects
    // on every Theme change thereafter.
    const unbindTheme = bindTheme(zeroSync);

    // One-time migration: remove the old localStorage send queue. Zero's
    // IDB outbox now owns durability; the localStorage key is dead weight.
    try {
      localStorage.removeItem("friday:sendQueue");
    } catch {
      // ignore
    }

    // Global Cmd/Ctrl-K to toggle the command palette. Fires even when
    // an input is focused (Spotlight-style), but yields to IME composition.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "k" && e.key !== "K") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.isComposing) return;
      e.preventDefault();
      commandPalette.toggle();
    };
    window.addEventListener("keydown", onKey);

    if (data.health?.uptimeSec !== undefined) {
      uptimeMs = data.health.uptimeSec * 1000;
    }
    const i = setInterval(() => {
      if (data.daemonOnline) uptimeMs += 1000;
    }, 1000);
    if (signedIn && !isLogin) {
      startSSE();
      startConnectivity();
      startWakeLock();
    }

    // Mobile keyboard handling: when the soft keyboard opens, iOS Safari
    // scrolls the visual viewport up inside the layout viewport, which
    // drags `position: fixed` elements (the floating header, in
    // particular) out of view. Track visualViewport.offsetTop in a CSS
    // var so the header can stay anchored to the *visible* top edge.
    //
    // **Only update while an input or textarea is focused** — without
    // this gate, iOS fires `visualViewport.scroll` events during chat
    // scroll-to-bottom animations and the offset wanders to mid-screen,
    // dragging the floating header down with it (the "snaps to center
    // of the screen while running" symptom). When no input is focused,
    // the keyboard isn't open and the offset is always 0 anyway; clearing
    // it explicitly prevents a stale value from sticking past a blur.
    //
    // Clamp the value defensively too: a runaway vv.offsetTop (older
    // Safari pinch-zoom edge case) would otherwise position the header
    // at arbitrary screen coordinates. 200px caps it at "definitely
    // still near the top of the visible area."
    const vv = window.visualViewport;
    let vvUpdate: (() => void) | undefined;
    if (vv) {
      const setOffset = (value: number) => {
        const clamped = Math.max(0, Math.min(value, 200));
        document.documentElement.style.setProperty(
          "--vv-offset-top",
          `${clamped}px`,
        );
      };
      vvUpdate = () => {
        const active = document.activeElement;
        const tag = active?.tagName;
        const isTextField =
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          (active instanceof HTMLElement && active.isContentEditable);
        setOffset(isTextField ? vv.offsetTop : 0);
      };
      vvUpdate();
      vv.addEventListener("resize", vvUpdate);
      vv.addEventListener("scroll", vvUpdate);
      // Re-evaluate when focus state changes — blur on the input must
      // immediately reset the offset to 0 even if no vv event fires.
      document.addEventListener("focusin", vvUpdate);
      document.addEventListener("focusout", vvUpdate);
    }

    // Soft-keyboard suppression — focus-based.
    //
    // The original height-delta detection (window.innerHeight - vv.height > 100)
    // doesn't fire on iOS PWA standalone: innerHeight shrinks together with
    // visualViewport.height when the keyboard opens, so the delta stays at 0
    // and `.keyboard-open` was never applied. Bug shown by screenshot Seth
    // sent — input pinned near the top with ~350px of dead space below it
    // (the home-indicator inset was still active above the form-accessory
    // bar + keyboard).
    //
    // Focus-based detection sidesteps the viewport math entirely: the soft
    // keyboard is open iff a text-entry field has focus. focusout is debounced
    // ~100ms so focus-to-focus transitions (textarea → another input without
    // the keyboard ever dismissing) don't briefly drop the class and flash
    // the layout.
    const isField = (el: Element | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };
    let blurTimeout: ReturnType<typeof setTimeout> | undefined;
    const onFocusIn = (e: FocusEvent) => {
      if (!isField(e.target as Element | null)) return;
      if (blurTimeout !== undefined) {
        clearTimeout(blurTimeout);
        blurTimeout = undefined;
      }
      document.documentElement.classList.add("keyboard-open");
    };
    const onFocusOut = () => {
      if (blurTimeout !== undefined) clearTimeout(blurTimeout);
      blurTimeout = setTimeout(() => {
        blurTimeout = undefined;
        if (!isField(document.activeElement)) {
          document.documentElement.classList.remove("keyboard-open");
        }
      }, 100);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);

    return () => {
      clearInterval(i);
      stopSSE();
      stopWakeLock();
      unbindTheme();
      window.removeEventListener("keydown", onKey);
      if (vv && vvUpdate) {
        vv.removeEventListener("resize", vvUpdate);
        vv.removeEventListener("scroll", vvUpdate);
        document.removeEventListener("focusin", vvUpdate);
        document.removeEventListener("focusout", vvUpdate);
      }
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      if (blurTimeout !== undefined) clearTimeout(blurTimeout);
      document.documentElement.classList.remove("keyboard-open");
    };
  });
  // The "Daemon unreachable — retrying" banner used to live here, gated
  // on `sseConnected` with a 5 s debounce. The ConnectivityWidget's
  // three dots already carry the same signal (and finer state — sync
  // vs daemon, reconnecting vs down), so the banner was redundant
  // visual noise.
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
  <!-- FRI-124: pre-paint FOUC-killer. Runs synchronously in <head>
       before <body> parses. Reads localStorage['friday:theme'] and
       stamps .palette-<name> + .dark (if kind=dark) on <html>, plus
       style.colorScheme and <meta name="theme-color">. See
       lib/theme/foucScript.ts. -->
  {@html `<script>${FOUC_SCRIPT}</script>`}
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

{#if signedIn && !isLogin}
  <SyncOverlay />
{/if}
<div class="app-shell">
  {#if signedIn && !isLogin}
    <header class="app-header">
      <div class="header-left">
        <a href="/" class="logo" onclick={closeMenu}>
          <img class="logo-icon" src={avatar} alt="Friday" />
          <span>Friday</span>
        </a>
        <span class="header-sep"></span>
        <!-- FIX_FORWARD 3.10: connectivity-chain widget replaces the
             previous Bot/Live dots. Three stages: Internet / SSE /
             Daemon with cascade-grey and a daemon-uptime tail. -->
        <ConnectivityWidget />
        {#if wakeLockState.held}
          <span
            class="wake-lock-indicator"
            title="Screen wake lock is active — phone won't sleep while an agent is working"
            aria-label="Screen wake lock active">
            <Coffee size={14} strokeWidth={2} aria-hidden="true" />
          </span>
        {/if}
      </div>
      <div class="header-right" bind:this={headerRightRef}>
        <nav class="header-nav">
          {#each visibleLinks as link (link.href)}
            {@const chatIcon = visibleLinks.length === 1 && link.href === "/"}
            <a
              href={link.href}
              class:active={link.match($page.url.pathname)}
              class:icon-link={chatIcon}
              aria-label={link.label}
              title={chatIcon ? link.label : undefined}
              onclick={closeMenu}>
              {#if chatIcon}
                <MessagesSquare size={16} strokeWidth={2} aria-hidden="true" />
              {:else}
                {link.label}
              {/if}
            </a>
          {/each}
        </nav>
        <button
          type="button"
          class="cmd-k-chip"
          bind:this={cmdkRef}
          onclick={() => commandPalette.openPalette()}
          title="Open command palette (⌘K)"
          aria-label="Open command palette"
          aria-keyshortcuts="Meta+K Control+K">
          ⌘K
        </button>
        {#if overflowLinks.length > 0}
          <div class="nav-more" bind:this={navMoreRef}>
            <button
              class="hamburger-btn"
              aria-haspopup="true"
              aria-expanded={menuOpen}
              aria-label="More navigation"
              onclick={() => (menuOpen = !menuOpen)}>
              <span></span><span></span><span></span>
            </button>
            {#if menuOpen}
              <nav class="nav-more-panel">
                {#each overflowLinks as link (link.href)}
                  <a
                    href={link.href}
                    class:active={link.match($page.url.pathname)}
                    onclick={closeMenu}>{link.label}</a>
                {/each}
              </nav>
            {/if}
          </div>
        {/if}

        <!-- Off-screen ghost: a full-strength copy of every link (plus a
             More button) used to measure intrinsic widths. Absolutely
             positioned + visibility:hidden so it never affects layout. -->
        <nav class="header-nav nav-ghost" bind:this={ghostNavRef} aria-hidden="true">
          {#each navLinks as link (link.href)}
            <a data-ghost-link href={link.href} tabindex="-1">{link.label}</a>
          {/each}
          <span class="hamburger-btn" data-ghost-more>
            <span></span><span></span><span></span>
          </span>
        </nav>
      </div>
    </header>
  {/if}

  <main class="app-main" class:no-header={!signedIn || isLogin} class:chat-route={isChat && signedIn && !isLogin}>
    {@render children()}
  </main>
</div>

<ConfirmDialog />
<CommandPalette />

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
    /* --vv-offset-top is set from visualViewport in +layout.svelte and
       keeps the header pinned to the top of the *visible* viewport when
       the mobile keyboard is open. Defaults to 0 on desktop. */
    top: calc(1rem + var(--vv-offset-top, 0px));
    left: 50%;
    transform: translateX(-50%);
    width: calc(100% - 2rem);
    max-width: 1260px;
    /* Higher than the chat sidebar (50) AND its open dropdown (200 inside
       Sidebar.svelte) — without this, on the mobile breakpoint where the
       sidebar trigger spans the full content width, a tap on the hamburger
       at the top-right can route to the sidebar's stacking context first. */
    z-index: 250;
    backdrop-filter: blur(20px) saturate(160%);
    border-radius: 999px;
    box-shadow: var(--shadow-lg);
    gap: 1rem;
  }

  .header-left { display: flex; align-items: center; gap: 0.75rem; min-width: 0; }
  /* header-right claims the flex leftover after header-left and right-aligns
     its cluster. Because its box width is the leftover (not its content), it
     stays constant as nav links move in/out of the More menu — that's what
     makes the priority+ split in +layout.svelte's script bounce-free. */
  .header-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1 1 auto;
    min-width: 0;
    justify-content: flex-end;
    position: relative;
  }

  .header-sep { width: 1px; height: 1.2rem; background: var(--border-primary); flex-shrink: 0; }
  .wake-lock-indicator {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--accent-primary);
    opacity: 0.9;
    flex-shrink: 0;
  }

  .logo {
    display: flex; align-items: center; gap: 0.5rem;
    font-size: 1.1rem; font-weight: 700; letter-spacing: -0.03em;
    color: var(--text-primary); flex-shrink: 0; text-decoration: none;
    transition: opacity var(--transition-fast);
  }
  .logo:hover { opacity: 0.8; }
  .logo-icon { width: 1.7rem; height: 1.7rem; border-radius: var(--radius-sm); object-fit: cover; flex-shrink: 0; }

  /* The visible-links row. min-width:0 + overflow:hidden lets it clip
     (rather than push the cluster wider) during the first paint before the
     ghost has been measured; once measured, visibleLinks always fits. */
  .header-nav {
    display: flex;
    gap: 0.25rem;
    min-width: 0;
    overflow: hidden;
    flex-wrap: nowrap;
  }
  .header-nav a {
    padding: 0.35rem 0.75rem; font-size: 0.8rem; font-weight: 500;
    color: var(--text-secondary); text-decoration: none;
    border-radius: var(--radius-sm); transition: all var(--transition-fast);
    white-space: nowrap;
  }
  .header-nav a:hover { color: var(--text-primary); background: var(--bg-tertiary); }
  .header-nav a.active { color: var(--accent-primary); background: var(--accent-glow); }
  /* When only "Chat" survives the overflow it collapses to its icon. */
  .header-nav a.icon-link { display: inline-flex; align-items: center; }

  /* Off-screen measuring ghost — out of flow, never visible. */
  .nav-ghost {
    position: absolute;
    left: 0;
    top: 0;
    visibility: hidden;
    pointer-events: none;
    overflow: visible;
    white-space: nowrap;
  }

  /* Priority+ overflow ("More") menu. */
  .nav-more { position: relative; display: flex; align-items: center; flex-shrink: 0; }
  .nav-more-panel {
    position: absolute;
    top: calc(100% + 0.5rem);
    right: 0;
    display: flex;
    flex-direction: column;
    min-width: 11rem;
    padding: 0.375rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    z-index: 200;
  }
  .nav-more-panel a {
    padding: 0.6rem 1rem; font-size: 0.875rem; font-weight: 500;
    color: var(--text-secondary); text-decoration: none;
    border-radius: var(--radius-sm); white-space: nowrap;
    transition: all var(--transition-fast);
  }
  .nav-more-panel a:hover { color: var(--text-primary); background: var(--bg-tertiary); }
  .nav-more-panel a.active { color: var(--accent-primary); background: var(--accent-glow); }

  .app-main { max-width: 1200px; margin: 0 auto; padding: 1.5rem; padding-top: 5.5rem; }
  .app-main.no-header { padding-top: 1.5rem; max-width: none; padding: 0; }
  .app-main.chat-route { max-width: none; margin: 0; padding: 0; }

  .cmd-k-chip {
    display: inline-flex;
    align-items: center;
    background: none;
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    padding: 0.2rem 0.5rem;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
    cursor: pointer;
    flex-shrink: 0;
    transition: all var(--transition-fast);
  }
  .cmd-k-chip:hover {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
    background: var(--accent-glow);
  }
  @media (max-width: 640px) {
    .cmd-k-chip { display: none; }
  }

  .hamburger-btn {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    cursor: pointer;
    /* Keep original padding so the button's layout box stays at its natural
       ~22px height — the header height is unchanged. The ::before below
       carries the 44×44px HIG hit area as overflow (pointer-events still
       fire because the button's overflow is visible). */
    padding: 0.25rem;
    flex-shrink: 0;
    position: relative;
    touch-action: manipulation;
  }
  /* Invisible hit-area extension. Centered on the button, overflows its
     border box without affecting layout (position: absolute, no size on
     the parent changes). Taps in this zone route to the button because
     ::before is a child of the button element. */
  .hamburger-btn::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    min-width: 44px;
    min-height: 44px;
  }
  .hamburger-btn span {
    display: block; width: 1.25rem; height: 2px; background: var(--text-primary);
    border-radius: 2px; transition: background var(--transition-fast);
  }
  .hamburger-btn:hover span { background: var(--accent-primary); }

  @media (max-width: 640px) {
    .app-header { border-radius: var(--radius-lg); padding: 0.75rem 0.4rem; }
    .app-main { padding: 1rem; padding-top: 5rem; }
    .logo span { display: none; }
  }
</style>
