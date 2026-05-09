<script lang="ts">
  import { page } from "$app/stores";
  import { onMount } from "svelte";

  interface NavItem {
    href: string;
    label: string;
    icon?: string;
  }

  const items: NavItem[] = [
    { href: "/", label: "Chat" },
    { href: "/dashboard", label: "Dashboard" },
    { href: "/sessions", label: "Sessions" },
    { href: "/tickets", label: "Tickets" },
    { href: "/schedules", label: "Schedules" },
    { href: "/memory", label: "Memory" },
    { href: "/evolve", label: "Evolve" },
    { href: "/skills", label: "Skills" },
    { href: "/logs", label: "Logs" },
    { href: "/settings", label: "Settings" },
  ];

  let containerRef: HTMLElement | undefined = $state();
  let measuredWidths: number[] = $state([]);
  let containerWidth: number = $state(0);
  let mobileOpen: boolean = $state(false);

  // Priority+ split: how many items fit, the rest go in More.
  let visibleCount: number = $derived.by(() => {
    if (containerWidth === 0 || measuredWidths.length === 0) return items.length;
    const moreReserved = 80;
    let used = 0;
    for (let i = 0; i < items.length; i++) {
      const w = measuredWidths[i] ?? 100;
      const remaining = items.length - i - 1;
      const reserved = remaining > 0 ? moreReserved : 0;
      if (used + w + reserved > containerWidth) return i;
      used += w;
    }
    return items.length;
  });

  let visible = $derived(items.slice(0, visibleCount));
  let overflow = $derived(items.slice(visibleCount));

  let isMobile: boolean = $state(false);

  onMount(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    isMobile = mq.matches;
    mq.addEventListener("change", (e) => (isMobile = e.matches));

    if (!containerRef) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        containerWidth = entry.contentRect.width;
      }
    });
    ro.observe(containerRef);

    // Measure once after first render.
    requestAnimationFrame(() => {
      const buttons = containerRef!.querySelectorAll<HTMLAnchorElement>(
        "[data-nav-item]",
      );
      measuredWidths = [...buttons].map((b) => b.offsetWidth + 12);
    });

    return () => ro.disconnect();
  });
</script>

<header class="nav">
  <a href="/" class="brand">
    <span class="crown">👑</span> Friday
  </a>

  {#if isMobile}
    <button class="hamburger" aria-label="Menu" onclick={() => (mobileOpen = !mobileOpen)}>
      <span></span><span></span><span></span>
    </button>
  {:else}
    <nav class="links" bind:this={containerRef}>
      {#each visible as item}
        <a
          href={item.href}
          data-nav-item
          class:active={$page.url.pathname === item.href ||
            ($page.url.pathname.startsWith(item.href) && item.href !== "/")}>
          {item.label}
        </a>
      {/each}
      {#if overflow.length > 0}
        <details class="more">
          <summary>More</summary>
          <div class="more-panel">
            {#each overflow as item}
              <a href={item.href}>{item.label}</a>
            {/each}
          </div>
        </details>
      {/if}
    </nav>
  {/if}
</header>

{#if mobileOpen}
  <div
    class="mobile-menu"
    role="presentation"
    onclick={() => (mobileOpen = false)}
    onkeydown={(e) => e.key === "Escape" && (mobileOpen = false)}>
    {#each items as item}
      <a href={item.href}>{item.label}</a>
    {/each}
  </div>
{/if}

<style>
  .nav {
    position: sticky;
    top: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 1rem;
    background: var(--bg-2);
    border-bottom: 1px solid var(--border);
    height: 56px;
  }
  .brand {
    font-weight: 600;
    color: var(--text);
  }
  .crown {
    margin-right: 0.25rem;
  }
  .links {
    display: flex;
    gap: 0.25rem;
    align-items: center;
    flex: 1 1 auto;
    justify-content: flex-end;
    overflow: hidden;
    white-space: nowrap;
  }
  .links a {
    padding: 0.4rem 0.75rem;
    border-radius: 6px;
    color: var(--subtext);
  }
  .links a.active {
    background: var(--surface);
    color: var(--text);
  }
  .links a:hover {
    text-decoration: none;
    background: var(--surface);
    color: var(--text);
  }
  .more {
    position: relative;
  }
  .more summary {
    list-style: none;
    cursor: pointer;
    padding: 0.4rem 0.75rem;
    color: var(--subtext);
    border-radius: 6px;
  }
  .more summary::-webkit-details-marker {
    display: none;
  }
  .more-panel {
    position: absolute;
    right: 0;
    top: 100%;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.25rem;
    min-width: 160px;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .more-panel a {
    padding: 0.4rem 0.75rem;
    border-radius: 4px;
  }
  .hamburger {
    background: transparent;
    border: none;
    width: 44px;
    height: 44px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
    padding: 0 8px;
  }
  .hamburger span {
    display: block;
    height: 2px;
    background: var(--text);
  }
  .mobile-menu {
    position: fixed;
    top: 56px;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--bg);
    z-index: 99;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .mobile-menu a {
    padding: 0.75rem 1rem;
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    min-height: 44px;
    display: flex;
    align-items: center;
  }
</style>
