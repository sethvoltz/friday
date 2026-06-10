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
  import {
    chaseScrollBottom,
    makeWindowChaseTarget,
    type ResyncChaseHandle,
  } from "$lib/components/Chat/resync-scroll";
  import {
    afterNextPaint,
    scrollByDelta,
    scrollToBottom,
  } from "$lib/components/Chat/doc-scroll";
  import { isTextEntryElement } from "$lib/util/keyboard-inset";
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

  // Inert query root for anchor bookkeeping (`.list` ResizeObserver,
  // `[data-msg-id]` bubble lookups) — NOT a scroller. The DOCUMENT is
  // the only scroller on the chat route (FRI-160); all scroll reads and
  // writes go through the window seam in doc-scroll.ts.
  let transcriptEl: HTMLElement | undefined = $state();
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
  // FRI-161: a past session older than the narrow cold-start window would,
  // mid-backfill, have `blocksResultType === "complete"` but zero matching
  // rows — rendering an empty transcript instead of a skeleton. Treat a
  // not-yet-full window (`!blocksFullWindow`) as still-loading so the
  // skeleton holds until the backfill reaches this session.
  let pastLoading = $derived(
    readonly &&
      sessionId !== undefined &&
      (zeroSync.blocksAgent !== agent ||
        zeroSync.blocksResultType !== "complete" ||
        !zeroSync.blocksFullWindow) &&
      pastMessages.length === 0,
  );

  // Drops any deferred anchor-restore correction queued by the `.list`
  // ResizeObserver below (assigned inside that $effect; no-op until it
  // mounts). The document scroller is global, so a queued `scrollBy`
  // outlives the slice/view that motivated it — anything that asserts
  // new scroll ownership (jump-to-bottom, a resync chase, teardown)
  // must invalidate pending corrections or a stale relative write
  // lands 1–2 frames later and yanks the viewport off its new target.
  let invalidatePendingRestore: () => void = () => {};

  // Entry point for ChatMessages's window slides into the single
  // anchor-restore owner below (assigned inside the `.list` $effect).
  // See that effect's doc-comment for why slides can't rely on the
  // ResizeObserver alone (net-zero-height slides never fire it).
  let notifyListMutation: () => void = () => {};

  async function jumpToBottom() {
    // A correction queued for the pre-jump geometry must not land on
    // top of the bottom we're about to scroll to.
    invalidatePendingRestore();
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
    scrollToBottom();
    // Optimistic update so the jump-button hides immediately; the
    // bottom-sentinel observer will confirm on its next tick.
    if (!readonly) chat.pinnedToBottom = true;
  }

  // Handle for the in-flight post-resync bottom-chase loop. Agent /
  // session switches abort the previous chase before starting the
  // next; the loop also self-aborts on direct user scroll input
  // (wheel / touchmove / keydown — see `chaseScrollBottom`).
  let activeChase: ResyncChaseHandle | null = null;

  /**
   * Kick off the post-resync bottom chase. See `resync-scroll.ts` for
   * the full rationale: the symptom without this is the last turn
   * landing roughly half a bubble below the fold because the canonical
   * Zero blocks snapshot grows the list AFTER the initial scrollTop
   * write. One-shot, not sticky.
   */
  function startResyncChase(): void {
    activeChase?.abort();
    // The chase owns the scroll for its window — a stale deferred
    // anchor-restore from the previous agent/session must not land
    // mid-chase (or just after it ends).
    invalidatePendingRestore();
    // The chase target is the document scroller — built lazily here
    // (client-only call sites) so SSR never touches window/document.
    activeChase = chaseScrollBottom(makeWindowChaseTarget(), {
      now: () => performance.now(),
      raf: (cb) => requestAnimationFrame(cb),
      cancelRaf: (h) => cancelAnimationFrame(h),
      onEnd: () => {
        activeChase = null;
      },
    });
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
        chat.resetChatWindowToLatest();
        await tick();
        scrollToBottom();
        chat.pinnedToBottom = true;
        startResyncChase();
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

  // Past-session view: when the first non-empty Zero snapshot lands
  // (or the user navigates to a different past session), kick off the
  // same bottom-chase loop. Same root cause as the live path —
  // pastMessages is async and grows the rendered list below the
  // initial scroll position. Keyed on (agent, sessionId) so each
  // distinct past session gets exactly one chase.
  let readonlyChaseKey: string | null = null;
  $effect(() => {
    if (!readonly) return;
    const key = `${agent}::${sessionId ?? ""}`;
    const hasMessages = pastMessages.length > 0;
    untrack(() => {
      if (hasMessages && readonlyChaseKey !== key) {
        readonlyChaseKey = key;
        startResyncChase();
      } else if (!hasMessages && readonlyChaseKey !== null) {
        // Session changed away or data hasn't landed yet — re-arm so
        // the next non-empty snapshot fires a fresh chase.
        readonlyChaseKey = null;
      }
    });
  });

  // Abort any in-flight chase on unmount so the rAF loop doesn't
  // dereference a torn-down scroller.
  $effect(() => {
    return () => {
      activeChase?.abort();
      activeChase = null;
    };
  });

  // Initial scroll-to-bottom + scroll-pin while streaming.
  $effect(() => {
    queueMicrotask(() => scrollToBottom());
  });

  // Soft-keyboard open/close shrinks/grows the visual viewport (in the
  // standalone-PWA regime, the layout viewport itself — see
  // $lib/util/keyboard-inset.ts for the regime split). If the user was
  // pinned to the bottom, keep them there: without this, opening the
  // keyboard hides the conversation tail behind it (standalone) or
  // leaves the last message under the lifted composer after the
  // transcript's --kb-inset padding grows (Safari tab). Gated on a
  // focused text field so URL-bar collapse resizes during normal
  // scrolling never issue scroll writes; the write itself re-checks the
  // pin at landing time (same discipline as every other deferred write
  // here).
  $effect(() => {
    if (readonly) return;
    const vv = window.visualViewport;
    if (!vv) return;
    let cancel: (() => void) | null = null;
    const onVvResize = () => {
      if (!isTextEntryElement(document.activeElement)) return;
      if (!chat.pinnedToBottom) return;
      cancel?.();
      cancel = afterNextPaint(() => {
        cancel = null;
        if (chat.pinnedToBottom) scrollToBottom();
      });
    };
    vv.addEventListener("resize", onVvResize);
    // The layout viewport can resize with no vv event (iOS 26 bottom-bar
    // Safari resizes it at keyboard-animation end) — same focused+pinned
    // gate, same deferred write.
    window.addEventListener("resize", onVvResize);
    return () => {
      cancel?.();
      vv.removeEventListener("resize", onVvResize);
      window.removeEventListener("resize", onVvResize);
    };
  });

  $effect(() => {
    if (!inputEl) return;
    const ro = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height;
      // Set on the document root so the chat-transcript padding *and* the
      // sibling floating pills (.jump-to-bottom-wrap, .loading-older) all
      // see the same live value via inheritance.
      document.documentElement.style.setProperty("--chat-input-h", `${h}px`);
      if (pinnedToBottom) scrollToBottom();
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
      if (pinnedToBottom) {
        queueMicrotask(() => {
          if (pinnedToBottom) scrollToBottom();
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
  // dashboard disables it explicitly (see .chat-transcript's
  // overflow-anchor: none) to avoid fighting this manual scroll math. So
  // we implement scroll anchoring ourselves: cache the topmost message
  // that's visible (its id + offset from the viewport top — the document
  // is the scroller) on every scroll event, then on every ResizeObserver
  // tick adjust the window scroll by whatever delta that anchor moved,
  // returning the user's viewport to where they were looking.
  //
  // This effect is the SINGLE owner of anchor-restore for every `.list`
  // mutation — ChatMessages's window slides and older-page prepends
  // deliberately do NOT restore on their own (FRI-160). With the writes
  // deferred (double-rAF, below), a second restorer measuring the same
  // mutation against its own anchor would queue a second full-height
  // correction and the viewport would jump by the prepended height
  // instead of holding still.
  //
  // Two triggers feed the one restore path:
  //   - the ResizeObserver on `.list`, for content-growth mutations
  //     (late mermaid/KaTeX/image mounts, tool expands, prepends);
  //   - the `onWindowSlide` hook ChatMessages calls after a window
  //     slide. The hook is load-bearing, not belt-and-braces: a slide
  //     mounts SLIDE_AMOUNT bubbles on one edge and unmounts the same
  //     count on the other, so `.list`'s NET height change can be ~0px
  //     and the RO never fires — yet every retained bubble shifted by
  //     the full prepended height. Both triggers share one anchor and
  //     one pending delta (anchorOffset advances eagerly on measure),
  //     so whichever runs second measures a delta of 0 — double-apply
  //     stays impossible.
  $effect(() => {
    if (!transcriptEl) return;
    const root = transcriptEl;
    const inner = root.querySelector(".list");
    if (!inner) return;

    let anchorEl: HTMLElement | null = null;
    let anchorOffset = 0;

    function snapshotAnchor() {
      // The document is the scroller, so the reference line is the
      // viewport top (≡ 0). First message bubble whose bottom is still
      // inside (or below) it — i.e. the topmost element the user can
      // actually see (or the one that just scrolled off the top by a
      // hair).
      const bubbles = root.querySelectorAll<HTMLElement>("[data-msg-id]");
      for (const el of bubbles) {
        const r = el.getBoundingClientRect();
        if (r.bottom > 0) {
          anchorEl = el;
          anchorOffset = r.top;
          return;
        }
      }
      anchorEl = null;
    }

    snapshotAnchor();
    // Document scrolls fire the `scroll` event at the document, where a
    // `window` listener receives it. A listener on the inert
    // `.chat-transcript` (no overflow) would silently never fire.
    window.addEventListener("scroll", snapshotAnchor, { passive: true });

    // WebKit/iOS Safari paint-defer mitigation, document-scroller
    // edition. A programmatic scroll write that lands while
    // the scroll thread is still hot (mid-momentum or just-stopped)
    // defers paint of the newly-revealed region until the next user
    // scroll. The old fixed-overlay scroller forced a paint commit by
    // toggling overflow-y:hidden; with the document as the scroller
    // there is no element overflow to toggle (and overflow:hidden on
    // <html>/<body> is unreliable on iOS WebKit — #153852, #240860), so
    // the write is instead deferred past the in-flight frame via
    // double-rAF (`afterNextPaint` in doc-scroll.ts). Writes go through
    // window.scrollTo/scrollBy with behavior:'auto' — NEVER 'smooth' on
    // the follow path (WebKit #238497: smooth programmatic scrolls can
    // silently no-op).
    // Deferred-correction bookkeeping. Deferring the writes (double-rAF,
    // see above) loses the old synchronous ordering guarantee that each
    // RO tick observed already-corrected geometry, so two invariants are
    // enforced by hand here:
    //   1. COALESCE — corrections accumulate into one pending delta
    //      flushed once per afterNextPaint. Two resizes landing within
    //      the 2-frame defer window (consecutive late image / mermaid /
    //      KaTeX mounts above the anchor) would otherwise each queue a
    //      full write and double-apply the first delta.
    //   2. CANCELLABLE — the handles let jumpToBottom / chase start /
    //      teardown drop a queued write before it lands on a view that
    //      no longer wants it (the document scroller is global; queued
    //      writes don't die with the DOM that motivated them).
    let pendingRestoreDelta = 0;
    let cancelQueuedRestore: (() => void) | null = null;
    let cancelQueuedFollow: (() => void) | null = null;

    function invalidateRestore() {
      pendingRestoreDelta = 0;
      cancelQueuedRestore?.();
      cancelQueuedRestore = null;
    }
    invalidatePendingRestore = invalidateRestore;

    function handleListMutation() {
      // Bottom-pinned *and* a turn is active: follow new output to the
      // bottom. Without the turn-active gate, every content-height
      // change snapped at-bottom users to the bottom — including idle
      // interactions like expanding a tool block, which would yank the
      // history up the screen before the user could read the expanded
      // content. Anchor-restore (below) is the right behavior outside
      // of an active turn; the streaming-text follow path lives in the
      // message-data effect above and doesn't go through this RO.
      if (pinnedToBottom && turnActive) {
        // Following supersedes restoring — a pending anchor-restore
        // would land on top of the follow write and pull us off the
        // bottom.
        invalidateRestore();
        if (!cancelQueuedFollow) {
          cancelQueuedFollow = afterNextPaint(() => {
            cancelQueuedFollow = null;
            // Re-check the gate at write time — the turn may have ended
            // (or the user unpinned) during the two-frame defer. The
            // write is absolute (reads scrollHeight at write time), so
            // one queued follow covers any further growth that lands
            // during the defer.
            if (pinnedToBottom && turnActive) scrollToBottom();
          });
        }
        return;
      }
      // Mid-history (or idle-at-bottom): anchor-restore. If our cached
      // anchor is gone (DOM re-rendered the bubble) or never existed,
      // re-snapshot and bail — we have no "before" to compare to this
      // tick.
      if (!anchorEl || !root.contains(anchorEl)) {
        snapshotAnchor();
        return;
      }
      // Measure the delta NOW (synchronously with the resize that fired
      // this RO) so a user scroll during the deferred frames is
      // preserved rather than undone; only the write is deferred.
      const newOffset = anchorEl.getBoundingClientRect().top;
      const delta = newOffset - anchorOffset;
      if (delta === 0) return;
      // Eagerly advance the cached offset to the just-measured one so
      // the NEXT tick measures only its own shift. Without this, a
      // second resize inside the defer window would re-measure the
      // still-pending delta against the same stale anchorOffset and the
      // two writes would over-correct by the first delta. The scroll
      // event the flushed write triggers re-snapshots against reality
      // anyway.
      anchorOffset = newOffset;
      pendingRestoreDelta += delta;
      if (!cancelQueuedRestore) {
        cancelQueuedRestore = afterNextPaint(() => {
          cancelQueuedRestore = null;
          const d = pendingRestoreDelta;
          pendingRestoreDelta = 0;
          if (d !== 0) scrollByDelta(d);
        });
      }
    }

    const ro = new ResizeObserver(() => handleListMutation());
    ro.observe(inner);
    notifyListMutation = handleListMutation;

    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", snapshotAnchor);
      // Drop queued writes — they'd land 1–2 frames after teardown
      // against whatever view (route, agent) is current by then.
      invalidateRestore();
      cancelQueuedFollow?.();
      cancelQueuedFollow = null;
      invalidatePendingRestore = () => {};
      notifyListMutation = () => {};
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

<div class="chat-transcript" bind:this={transcriptEl}>
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
    loadingOlderPast={false}
    onWindowSlide={() => notifyListMutation()} />
</div>

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

<!-- FRI-156 §E: sticky "Viewing pre-compaction history" pill. Shown when the
     user is scrolled above the most-recent compaction divider
     (chat.viewingPreCompaction, set by ChatMessages's IntersectionObserver).
     Click scrolls back to the divider via the nonce-keyed scrollTarget. -->
{#if !readonly && chat.viewingPreCompaction}
  <div class="pre-compaction-wrap">
    <button
      class="floating-pill pre-compaction"
      type="button"
      onclick={() => chat.scrollToLatestCompactionDivider()}
      aria-label="Scroll to the latest compaction divider">
      Viewing pre-compaction history
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
  .chat-transcript,
  .chat-sidebar-floating,
  .chat-input-floating,
  .jump-to-bottom-wrap,
  .pre-compaction-wrap,
  .loading-older {
    --page-gutter: max(1rem, calc((100vw - 1200px) / 2));
    --sidebar-w: 240px;
    --chat-inset: 1rem;
    --content-gap: var(--chat-inset);
    --content-left: calc(var(--page-gutter) + var(--sidebar-w) + var(--content-gap));
    --chat-top: calc(4.3rem + var(--chat-inset));
  }

  /* Inert in-flow transcript block — the DOCUMENT is the only scroller
     on the chat route (FRI-160), same as every other page. No
     position:fixed / overflow here: the old full-viewport fixed-overlay
     scroller intermittently lost the touch-routing fight with the
     document on iOS/WebKit (the whole view rubber-banded as a chunk
     instead of scrolling the chat). The header / sidebar / composer /
     floating pills stay position:fixed — pinned bars, not competing
     scrollers — and this padding reserves their room in the flow. */
  .chat-transcript {
    /* Chromium-side belt-and-braces: disable the browser's scroll-
       anchoring heuristic so it doesn't fight the manual anchor-restore
       scroll math in ChatShell's `.list` ResizeObserver (the single
       restore owner — covers window slides and older-page prepends
       too). No-op on WebKit, free. The WebKit-specific paint-deferral
       mitigation lives at the call sites (double-rAF around the window
       scroll writes — see doc-scroll.ts). */
    overflow-anchor: none;
    padding-top: var(--chat-top);
    /* Mirrors the floating input offset so the last message scrolls fully above it. */
    padding-bottom: calc(var(--chat-input-h, 6rem) + 2 * var(--chat-inset) + var(--kb-safe-bottom, 0px) + var(--kb-inset, 0px));
    padding-left: var(--content-left);
    padding-right: var(--page-gutter);
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
    bottom: calc(1rem + var(--kb-safe-bottom, 0px) + var(--kb-inset, 0px));
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
    bottom: calc(var(--chat-input-h, 6rem) + 3rem + var(--kb-safe-bottom, 0px) + var(--kb-inset, 0px));
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
  /* FRI-156 §E: the pre-compaction pill sits at the top of the chat area —
     the divider it points back to is below the viewport (the user scrolled
     up into pre-compaction history), so the affordance to return to it
     anchors under the header. Offset BELOW .loading-older (which shares the
     top band) so that if both surface at once — scrolling up above the
     divider can also trigger older-block pagination — they stack rather than
     render at identical coordinates and overlap. */
  .pre-compaction-wrap {
    position: fixed;
    top: calc(var(--chat-top) + 3rem);
    left: var(--content-left);
    right: var(--page-gutter);
    display: flex;
    justify-content: center;
    pointer-events: none;
    z-index: 95;
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
    .chat-transcript {
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
    .pre-compaction-wrap,
    .loading-older {
      left: var(--page-gutter);
      right: var(--page-gutter);
    }
    .loading-older {
      top: calc(var(--chat-top) + 3.75rem);
    }
    /* Stacked below .loading-older on mobile too. */
    .pre-compaction-wrap {
      top: calc(var(--chat-top) + 6.25rem);
    }
  }

  @media (max-width: 640px) {
    .chat-input-floating { bottom: calc(0.5rem + var(--kb-safe-bottom, 0px) + var(--kb-inset, 0px)); }
  }
</style>
