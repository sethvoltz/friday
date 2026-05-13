<script lang="ts">
  import ChatMessages from "$lib/components/Chat/ChatMessages.svelte";
  import ChatInput from "$lib/components/Chat/ChatInput.svelte";
  import Sidebar from "$lib/components/Sidebar/Sidebar.svelte";
  import {
    chat,
    parseBlocks,
    oldestBlockCursor,
    type BlockRow,
    type ChatMessage,
  } from "$lib/stores/chat.svelte";
  import { initialPageSize } from "$lib/util/page-size";
  import { onMount, tick, untrack } from "svelte";

  interface Props {
    /** Agent whose chat to display. */
    agent: string;
    /** When set, render this specific session's turns read-only (no input,
     * no SSE wiring). Without it, the shell is the agent's active chat. */
    sessionId?: string;
  }
  let { agent, sessionId }: Props = $props();
  let readonly = $derived(sessionId !== undefined);

  let scrollEl: HTMLElement | undefined = $state();
  let inputEl: HTMLDivElement | undefined = $state();

  // Read-only past-session views auto-pin to bottom on initial load and
  // never get SSE updates afterward, so they don't need the live observer.
  // Live mode reads from `chat.pinnedToBottom`, which the bottom sentinel
  // in ChatMessages maintains via IntersectionObserver.
  let pinnedToBottom = $derived(readonly ? true : chat.pinnedToBottom);

  // Read-only mode keeps its own messages list so SSE doesn't mutate it.
  let pastMessages = $state<ChatMessage[]>([]);
  let pastLoading = $state(false);
  let pastError = $state<string | null>(null);
  // FIX_FORWARD 3.7: paginated past-session loads.
  // FIX_FORWARD 3.8: client-controlled initial page size based on viewport +
  // network class. Older-page-loads stay at a steady 25 so scrolling up
  // doesn't cliff into 10-row pages on slow links.
  const PAST_PAGE_SIZE_OLDER = 25;
  let oldestPastBlockId = $state<string | null>(null);
  let pastReachedOldest = $state(false);
  let loadingOlderPast = $state(false);

  async function loadPastSession() {
    if (!readonly || !sessionId) return;
    const sid = sessionId;
    const a = agent;
    pastError = null;
    pastLoading = true;
    pastMessages = [];
    oldestPastBlockId = null;
    pastReachedOldest = false;
    const initialLimit = initialPageSize();
    try {
      const r = await fetch(
        `/api/agents/${a}/blocks?session_id=${encodeURIComponent(sid)}&limit=${initialLimit}`,
      );
      // Bail if user navigated to a different past session mid-fetch.
      if (sid !== sessionId) return;
      if (!r.ok) {
        pastError = `Couldn't load session (HTTP ${r.status})`;
        return;
      }
      const data = (await r.json()) as { blocks: BlockRow[] };
      if (sid !== sessionId) return;
      pastMessages = parseBlocks(data.blocks, a);
      oldestPastBlockId = oldestBlockCursor(data.blocks);
      if (data.blocks.length < initialLimit) pastReachedOldest = true;
    } catch {
      if (sid === sessionId) {
        pastError = "Couldn't load session (network)";
      }
    } finally {
      if (sid === sessionId) pastLoading = false;
    }
  }

  async function loadOlderPastBlocks(): Promise<void> {
    if (!readonly || !sessionId) return;
    if (pastReachedOldest || loadingOlderPast || !oldestPastBlockId) return;
    const sid = sessionId;
    const a = agent;
    const before = oldestPastBlockId;
    loadingOlderPast = true;
    try {
      const r = await fetch(
        `/api/agents/${a}/blocks?session_id=${encodeURIComponent(sid)}&before=${encodeURIComponent(before)}&limit=${PAST_PAGE_SIZE_OLDER}`,
      );
      if (sid !== sessionId) return;
      if (!r.ok) return;
      const data = (await r.json()) as { blocks: BlockRow[] };
      if (sid !== sessionId) return;
      if (data.blocks.length === 0) {
        pastReachedOldest = true;
        return;
      }
      const older = parseBlocks(data.blocks, a);
      const seen = new Set(pastMessages.map((m) => m.id));
      const fresh = older.filter((m) => !seen.has(m.id));
      pastMessages = [...fresh, ...pastMessages];
      oldestPastBlockId = oldestBlockCursor(data.blocks);
      if (data.blocks.length < PAST_PAGE_SIZE_OLDER) pastReachedOldest = true;
    } finally {
      if (sid === sessionId) loadingOlderPast = false;
    }
  }

  function jumpToBottom() {
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
    // Optimistic update so the jump-button hides immediately; the
    // bottom-sentinel observer will confirm on its next tick.
    if (!readonly) chat.pinnedToBottom = true;
  }

  // Active mode: keep focusedAgent in sync with the current route, reload
  // turns whenever the agent changes, and pin to the bottom of the new
  // agent's chat. Each agent is a separate conversation; carrying over
  // the previous agent's scrollTop made no sense as UX and produced a
  // real bug — if the previous agent was scrolled to the top, the new
  // agent's chat would land at scrollTop=0, the top sentinel would
  // already be in view, and the IntersectionObserver wouldn't re-fire
  // after `chat.oldestDbId` became valid (no intersection change → no
  // callback), leaving the user with one page and no way to load more.
  $effect(() => {
    if (readonly) return;
    const a = agent;
    untrack(() => {
      if (chat.focusedAgent !== a) chat.focusedAgent = a;
      void chat.loadAgentTurns(a).then(async () => {
        await tick();
        if (scrollEl) {
          scrollEl.scrollTop = scrollEl.scrollHeight;
          chat.pinnedToBottom = true;
        }
      });
    });
  });

  // Read-only mode: load past session turns whenever sessionId changes.
  $effect(() => {
    sessionId; // track
    loadPastSession();
  });

  // Initial scroll-to-bottom + scroll-pin while streaming.
  $effect(() => {
    if (scrollEl) {
      queueMicrotask(() => {
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
      });
    }
  });

  $effect(() => {
    if (!inputEl || !scrollEl) return;
    const ro = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height;
      // Set on the document root so the chat-scroll padding *and* the
      // sibling floating pills (.jump-to-bottom-wrap, .loading-older) all
      // see the same live value via inheritance.
      document.documentElement.style.setProperty("--chat-input-h", `${h}px`);
      if (pinnedToBottom && scrollEl) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
    });
    ro.observe(inputEl);
    return () => ro.disconnect();
  });

  $effect(() => {
    if (readonly) {
      pastMessages.length;
      pastMessages.at(-1)?.text;
    } else {
      chat.messages.length;
      chat.messages.at(-1)?.text;
    }
    untrack(() => {
      if (pinnedToBottom && scrollEl) {
        queueMicrotask(() => {
          if (scrollEl && pinnedToBottom) {
            scrollEl.scrollTop = scrollEl.scrollHeight;
          }
        });
      }
    });
  });

  // Reset --chat-input-h when there's no input rendered, so messages can
  // scroll all the way to the bottom of the viewport in read-only mode.
  $effect(() => {
    if (readonly) {
      document.documentElement.style.setProperty("--chat-input-h", "0px");
    }
  });
</script>

<aside class="chat-sidebar-floating">
  <Sidebar />
</aside>

<section class="chat-scroll" bind:this={scrollEl}>
  {#if readonly}
    <div class="readonly-banner">
      Past session — read only
    </div>
  {/if}
  <ChatMessages
    messages={readonly ? pastMessages : undefined}
    pastLoading={readonly ? pastLoading : false}
    pastError={readonly ? pastError : null}
    onRetryPast={readonly ? loadPastSession : undefined}
    onLoadOlderPast={readonly ? loadOlderPastBlocks : undefined}
    pastReachedOldest={readonly ? pastReachedOldest : false}
    loadingOlderPast={readonly ? loadingOlderPast : false} />
</section>

{#if !readonly && chat.loadingOlder}
  <div class="floating-pill loading-older" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    Loading older messages…
  </div>
{/if}

{#if !readonly && !pinnedToBottom}
  <div class="jump-to-bottom-wrap">
    <button
      class="floating-pill jump-to-bottom"
      type="button"
      onclick={jumpToBottom}
      aria-label="Scroll to latest">
      ↓ Latest
    </button>
  </div>
{/if}

<!-- FIX_FORWARD 6.1: transient toast surfaced by /jump and other client-
     side commands. Auto-dismisses via chat.setToast(message, level, ms). -->
{#if !readonly && chat.toast}
  <div class="toast toast-{chat.toast.level}" role="status" aria-live="polite">
    {chat.toast.message}
  </div>
{/if}

{#if !readonly}
  <div class="chat-input-floating" bind:this={inputEl}>
    <ChatInput />
  </div>
{/if}

<style>
  .chat-scroll,
  .chat-sidebar-floating,
  .chat-input-floating,
  .jump-to-bottom-wrap,
  .loading-older {
    --page-gutter: max(1rem, calc((100vw - 1200px) / 2));
    --sidebar-w: 240px;
    --chat-inset: 1rem;
    --content-gap: var(--chat-inset);
    --content-left: calc(var(--page-gutter) + var(--sidebar-w) + var(--content-gap));
    --chat-top: calc(4.3rem + var(--chat-inset));
  }

  .chat-scroll {
    position: fixed;
    inset: 0;
    overflow-y: auto;
    /* Chromium-side belt-and-braces: disable the browser's scroll-
       anchoring heuristic so it doesn't fight the manual scrollTop fix
       in ChatMessages.svelte → onPrepended. No-op on WebKit, free.
       The WebKit-specific paint-deferral fix lives at the call site
       (overflow-y toggle around the scrollTop write); CSS-level layer
       promotion isn't the right tool for that bug. */
    overflow-anchor: none;
    padding-top: var(--chat-top);
    padding-bottom: calc(var(--chat-input-h, 6rem) + 2 * var(--chat-inset));
    padding-left: var(--content-left);
    padding-right: var(--page-gutter);
    background: var(--bg-primary);
    z-index: 0;
  }

  .chat-sidebar-floating {
    position: fixed;
    top: var(--chat-top);
    bottom: 1rem;
    left: var(--page-gutter);
    width: var(--sidebar-w);
    overflow-y: auto;
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    z-index: 50;
  }

  .chat-input-floating {
    position: fixed;
    bottom: 1rem;
    left: var(--content-left);
    right: var(--page-gutter);
    background: var(--header-float-bg);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    backdrop-filter: blur(20px) saturate(160%);
    -webkit-backdrop-filter: blur(20px) saturate(160%);
    z-index: 90;
  }

  .readonly-banner {
    max-width: 800px;
    margin: 0 auto 1rem;
    padding: 0.5rem 1rem;
    text-align: center;
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    font-size: 0.85rem;
  }

  /* Wrapper spans the chat content area and centers the button within it,
     so "centered" means centered on the chat (not on the window). The
     wrapper is pointer-events:none so the area below the button still
     scrolls / receives clicks for the chat itself. */
  .jump-to-bottom-wrap {
    position: fixed;
    bottom: calc(var(--chat-input-h, 6rem) + 3rem);
    left: var(--content-left);
    right: var(--page-gutter);
    display: flex;
    justify-content: center;
    pointer-events: none;
    z-index: 95;
  }
  /* Loading-older pill mirrors the jump-to-bottom: same floating + blurred
     style, centered on the chat area, anchored just below the chat header. */
  .loading-older {
    position: fixed;
    top: calc(var(--chat-top) + 0.5rem);
    left: var(--content-left);
    right: var(--page-gutter);
    margin: 0 auto;
    width: max-content;
    z-index: 95;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  /* Shared bordered + blurred-background style for floating chat affordances. */
  .floating-pill {
    pointer-events: auto;
    padding: 0.45rem 0.95rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    background: var(--header-float-bg);
    backdrop-filter: blur(20px) saturate(160%);
    -webkit-backdrop-filter: blur(20px) saturate(160%);
    color: var(--text-primary);
    font-size: 0.8rem;
    font-weight: 500;
    box-shadow: var(--shadow-md);
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  button.floating-pill {
    cursor: pointer;
    font-family: inherit;
  }
  button.floating-pill:hover {
    background: var(--bg-card);
    border-color: var(--border-primary);
  }

  /* FIX_FORWARD 6.1: jump/search toast. Bottom-center pill with status
     colors. Auto-dismissed by chat.setToast's setTimeout. */
  .toast {
    position: fixed;
    bottom: 6rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 40;
    padding: 0.5rem 1rem;
    border-radius: var(--radius-lg);
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    font-size: 0.85rem;
    font-family: var(--font-mono);
    box-shadow: var(--shadow-lg);
  }
  .toast-warn {
    border-color: var(--status-warn, var(--accent-primary));
    color: var(--status-warn, var(--accent-primary));
  }
  .spinner {
    width: 0.85rem;
    height: 0.85rem;
    border: 2px solid var(--border-subtle);
    border-top-color: var(--accent-primary);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 768px) {
    .chat-sidebar-floating {
      top: var(--chat-top);
      bottom: auto;
      left: var(--page-gutter);
      right: var(--page-gutter);
      width: auto;
      overflow: visible;
    }
    .chat-scroll {
      padding-left: var(--page-gutter);
      padding-right: var(--page-gutter);
      padding-top: calc(var(--chat-top) + 3.25rem);
    }
    .chat-input-floating {
      left: var(--page-gutter);
      right: var(--page-gutter);
    }
    /* Mobile: full-width chat means the centering wrapper spans gutter to gutter. */
    .jump-to-bottom-wrap,
    .loading-older {
      left: var(--page-gutter);
      right: var(--page-gutter);
    }
    .loading-older {
      top: calc(var(--chat-top) + 3.75rem);
    }
  }

  @media (max-width: 640px) {
    .chat-input-floating { bottom: 0.5rem; }
  }
</style>
