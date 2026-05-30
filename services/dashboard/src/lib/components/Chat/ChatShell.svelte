<script lang="ts">
  import ChatMessages from "$lib/components/Chat/ChatMessages.svelte";
  import ChatInput from "$lib/components/Chat/ChatInput.svelte";
  import Sidebar from "$lib/components/Sidebar/Sidebar.svelte";
  import {
    chat,
    parseBlocks,
    zeroBlockRowToBlockRow,
  } from "$lib/stores/chat.svelte";
  import { zeroSync } from "$lib/stores/zero.svelte";
  import { tick, untrack } from "svelte";

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

  // True iff at least one message in the active chat is still being
  // produced (assistant streaming text deltas or a tool/thinking block
  // marked running). Gates the content-resize auto-scroll-to-bottom
  // below: when no turn is active, any height growth (tool expand,
  // late mermaid mount, code-highlight settle) anchor-restores instead
  // of force-snapping to the bottom. The "scrolled to bottom" sentinel
  // signal alone is too eager — being at the bottom shouldn't mean
  // "follow every future content growth," only "follow the current
  // turn's output."
  let turnActive = $derived(
    readonly
      ? false
      : chat.messages.some(
          (m) => m.status === "streaming" || m.status === "running",
        ),
  );

  // Read-only past-session view: source the transcript from Zero's
  // local replica, not REST. Zero already maintains an
  // agent-scoped slice for everything within the 90-day retention
  // window (`bindBlocksFor` in zero.svelte.ts), and a past session
  // touched within that window has 100% of its blocks already
  // local — IndexedDB-backed, no network round-trip needed. The
  // prior REST path paginated 25 blocks at a time, which for a
  // 4,400-block session like the user's main chat meant the
  // initial paint showed the trailing fraction and the
  // `data.blocks.length < initialLimit` heuristic claimed the
  // top-of-session was reached when in reality only the latest page
  // had loaded. Wholesale-replace with a derived view:
  //
  //   1. Ensure `zeroSync.bindBlocksFor(agent)` is active on mount /
  //      agent change — readonly mode deliberately doesn't touch
  //      `chat.focusedAgent`, so the live ChatShell's binder hook
  //      doesn't fire when the user navigates directly to
  //      /sessions/<agent>/<session>. Binding directly here is
  //      idempotent against a same-agent live view that already
  //      bound (the binder early-returns on `blocksAgent === agent`).
  //   2. Derive `pastMessages` by filtering `zeroSync.blocks` to
  //      `session_id === sessionId` and parsing via `parseBlocks`.
  //      ALL session blocks land in one go — no pagination, no
  //      "scroll up to load more" wiring, no `pastReachedOldest`
  //      heuristic.
  //
  // `pastLoading` flips false once Zero confirms the local replica
  // matches upstream for this query (`blocksResultType === "complete"`).
  // While still `'unknown'` (initial hydration from IndexedDB),
  // ChatMessages renders the skeleton — at most a fraction-of-a-second
  // perceived load.
  let pastMessages = $derived.by(() => {
    if (!readonly || !sessionId) return [];
    if (zeroSync.blocksAgent !== agent) return [];
    const sid = sessionId;
    const filtered = zeroSync.blocks.filter((r) => r.session_id === sid);
    if (filtered.length === 0) return [];
    return parseBlocks(filtered.map(zeroBlockRowToBlockRow), agent);
  });
  let pastLoading = $derived(
    readonly &&
      sessionId !== undefined &&
      (zeroSync.blocksAgent !== agent ||
        zeroSync.blocksResultType !== "complete") &&
      pastMessages.length === 0,
  );

  async function jumpToBottom() {
    if (!scrollEl) return;
    // With sliding-window virtualization, the bottom of the rendered
    // DOM is the bottom of the WINDOW, not the bottom of history. If
    // the user has slid the window back into history (chatWindowEnd <
    // chat.messages.length), simply scrolling to scrollHeight lands
    // them at the bottom of the wrong slice. Reset the window to the
    // tail first, await a tick so ChatMessages re-slices and remounts
    // the latest bubbles, then scroll.
    if (!readonly) {
      chat.resetChatWindowToLatest();
      await tick();
    }
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
  // after `chat.oldestBlockId` became valid (no intersection change → no
  // callback), leaving the user with one page and no way to load more.
  //
  // Readonly mode (past-session view) deliberately does NOT touch
  // chat.focusedAgent — that signal means "the agent the user is
  // live-chatting with right now," and a past-session view isn't a
  // live chat. The sidebar's active-row highlight derives from the
  // route ($page.params.agent) instead, so past-session views still
  // visually pin their agent in the sidebar without polluting the
  // live-state signal.
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

  // Read-only mode: bind the Zero blocks slice for this agent so
  // the derived `pastMessages` has data to filter. Idempotent — the
  // binder early-returns when already bound to the same agent (e.g.
  // the user navigates from /sessions/<agent> live view to
  // /sessions/<agent>/<session> read-only without crossing a focus
  // change).
  $effect(() => {
    if (!readonly) return;
    const a = agent;
    untrack(() => {
      zeroSync.bindBlocksFor(a);
    });
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

  // Async DOM mutations from mermaid (SVG mount), KaTeX (MathML layout),
  // shiki (token spans changing line heights), and any future late-mount
  // content land *after* Svelte's reactive effects have already committed
  // their scroll math. Without compensation, two visible bugs:
  //   1. Pinned-to-bottom users end up looking at the top of the late
  //      content instead of the bottom (extra height pushed below them).
  //   2. Mid-history users (scrolled up) see the viewport jump as
  //      content above the visible area expands and shifts everything
  //      down — classic broken-scroll-anchor UX.
  //
  // Browser-native `overflow-anchor: auto` would handle case 2, but the
  // dashboard disables it explicitly (see .chat-scroll's overflow-anchor:
  // none) to avoid fighting the manual scrollTop math in the pagination
  // prepend handler. So we implement scroll anchoring ourselves: cache
  // the topmost message that's visible (its id + offset from the scroller
  // top) on every scroll event, then on every ResizeObserver tick adjust
  // scrollTop by whatever delta that anchor moved, returning the user's
  // viewport to where they were looking.
  $effect(() => {
    if (!scrollEl) return;
    const inner = scrollEl.querySelector(".list");
    if (!inner) return;

    let anchorEl: HTMLElement | null = null;
    let anchorOffset = 0;

    function snapshotAnchor() {
      if (!scrollEl) return;
      const scrollerTop = scrollEl.getBoundingClientRect().top;
      // First message bubble whose bottom is still inside (or below) the
      // viewport top — i.e. the topmost element the user can actually see
      // (or the one that just scrolled off the top by a hair).
      const bubbles = scrollEl.querySelectorAll<HTMLElement>("[data-msg-id]");
      for (const el of bubbles) {
        const r = el.getBoundingClientRect();
        if (r.bottom > scrollerTop) {
          anchorEl = el;
          anchorOffset = r.top - scrollerTop;
          return;
        }
      }
      anchorEl = null;
    }

    snapshotAnchor();
    scrollEl.addEventListener("scroll", snapshotAnchor, { passive: true });

    // WebKit/iOS Safari paint-defer fix (same shape as the pagination
    // prepend handler in ChatMessages.svelte). A programmatic scrollTop
    // write that lands while the scroll thread is still hot (mid-momentum
    // or just-stopped) defers paint of the newly-revealed region until
    // the next user scroll. Toggling overflow-y: hidden synchronously
    // detaches the element from the scroll thread, forcing a paint
    // commit; the async restore reattaches with a fresh paint. Mobile-
    // critical: without this, iOS users get blank regions during
    // late-render-driven scroll adjustments.
    //
    // Re-entrancy: the restore always targets "" (let CSS overflow-y:
    // auto resume) rather than a snapshotted `prev`. The pagination
    // prepend handler in ChatMessages.svelte writes "hidden" and the
    // resulting `.list` height change synchronously fires this RO,
    // which used to capture `prev = "hidden"`. The trailing restore
    // then re-applied "hidden", permanently locking the scroller until
    // the element unmounted (matching the reported "switch session to
    // recover" workaround). Nothing else writes scrollEl.style.overflowY,
    // so "" — falling back to .chat-scroll's CSS auto — is the correct
    // steady state for every caller.
    function writeScrollTop(newTop: number) {
      if (!scrollEl) return;
      scrollEl.style.overflowY = "hidden";
      scrollEl.scrollTop = newTop;
      setTimeout(() => {
        if (scrollEl) scrollEl.style.overflowY = "";
      }, 0);
    }

    const ro = new ResizeObserver(() => {
      if (!scrollEl) return;
      // Bottom-pinned *and* a turn is active: follow new output to the
      // bottom. Without the turn-active gate, every content-height
      // change snapped at-bottom users to the bottom — including idle
      // interactions like expanding a tool block, which would yank the
      // history up the screen before the user could read the expanded
      // content. Anchor-restore (below) is the right behavior outside
      // of an active turn; the streaming-text follow path lives in the
      // message-data effect above and doesn't go through this RO.
      if (pinnedToBottom && turnActive) {
        writeScrollTop(scrollEl.scrollHeight);
        return;
      }
      // Mid-history (or idle-at-bottom): anchor-restore. If our cached
      // anchor is gone (DOM re-rendered the bubble) or never existed,
      // re-snapshot and bail — we have no "before" to compare to this
      // tick.
      if (!anchorEl || !scrollEl.contains(anchorEl)) {
        snapshotAnchor();
        return;
      }
      const scrollerTop = scrollEl.getBoundingClientRect().top;
      const newOffset = anchorEl.getBoundingClientRect().top - scrollerTop;
      const delta = newOffset - anchorOffset;
      if (delta === 0) return;
      writeScrollTop(scrollEl.scrollTop + delta);
      // We don't update anchorOffset here — the scrollTop write should
      // restore the anchor to its original offset, and the scroll
      // event the write triggers will re-snapshot anyway.
    });
    ro.observe(inner);

    return () => {
      ro.disconnect();
      scrollEl?.removeEventListener("scroll", snapshotAnchor);
    };
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
    pastError={null}
    onRetryPast={undefined}
    onLoadOlderPast={undefined}
    pastReachedOldest={readonly}
    loadingOlderPast={false} />
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
    /* Mirrors the floating input's bottom offset (1rem inset + safe-area)
       PLUS the input's own height so the last message can scroll fully
       above the input. --kb-safe-bottom is `env(safe-area-inset-bottom)`
       normally and 0 while the soft keyboard is open (see app.css +
       +layout.svelte visualViewport hook). */
    padding-bottom: calc(var(--chat-input-h, 6rem) + 2 * var(--chat-inset) + var(--kb-safe-bottom, 0px));
    padding-left: var(--content-left);
    padding-right: var(--page-gutter);
    background: var(--bg-primary);
    z-index: 0;
    /* touch-action: pan-y narrows the WebCore ScrollableArea router's
       claim to vertical pans only, so taps fall through to z-index
       hit-testing where the sidebar trigger and header correctly win.
       overscroll-behavior: contain prevents bounce compositor-frame lag
       that causes taps immediately after a scroll to land at wrong DOM
       positions. Both apply unconditionally — they're no-ops on desktop. */
    touch-action: pan-y;
    overscroll-behavior: contain;
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
    bottom: calc(1rem + var(--kb-safe-bottom, 0px));
    left: var(--content-left);
    right: var(--page-gutter);
    background: var(--header-float-bg);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    backdrop-filter: blur(20px) saturate(160%);
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
    bottom: calc(var(--chat-input-h, 6rem) + 3rem + var(--kb-safe-bottom, 0px));
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
    .chat-input-floating { bottom: calc(0.5rem + var(--kb-safe-bottom, 0px)); }
  }
</style>
