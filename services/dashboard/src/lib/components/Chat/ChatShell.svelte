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
    makeElementChaseTarget,
    type ResyncChaseHandle,
  } from "$lib/components/Chat/resync-scroll";
  import {
    afterNextPaint,
    onChatScroll,
    scrollByDelta,
    scrollToBottom,
    setChatScroller,
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

  // The chat's INNER scroller (ADR-041): `.chat-transcript`
  // (overflow-y:auto) inside the visual-viewport-sized fixed column.
  // Registered as the active scroller for the doc-scroll.ts seam below;
  // also the query root for anchor bookkeeping (`.list` ResizeObserver,
  // `[data-msg-id]` bubble lookups).
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

  // ADR-041: register the transcript as the chat scroll
  // seam's active scroller, and lock body/document scroll on the chat
  // route so iOS never pans the visual viewport during scroll (the
  // source of the keyboard-up composer stutter under document scroll).
  // The composer lives in normal flow at the bottom of the
  // viewport-sized flex column, so it never overlaps the transcript —
  // no clearComposerOverlap needed.
  $effect(() => {
    if (!transcriptEl) return;
    setChatScroller(transcriptEl);
    document.documentElement.classList.add("chat-scroll-lock");
    return () => {
      setChatScroller(null);
      document.documentElement.classList.remove("chat-scroll-lock");
    };
  });

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
    // The chase target is the inner scroller element. Bail if it hasn't
    // bound yet (SSR / first paint); the agent-load effect re-chases.
    if (!transcriptEl) return;
    activeChase = chaseScrollBottom(makeElementChaseTarget(transcriptEl), {
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

  // `?kbdebug` diagnostics (documented in docs/mobile-ux.md): the
  // instrument that established the iOS 26.5 keyboard geometry; kept
  // until WebKit's viewport reporting stabilizes.
  // Two parts, both dev-only:
  //   1. ?kbdebug renders the live keyboard-geometry inputs as a fixed
  //      HUD overlay.
  //   2. In dev builds, every keyboard open posts geometry snapshots
  //      (at +120/+600/+1500ms, when the animation should be settling)
  //      to /api/_diag/client-error, which lands them in the dashboard
  //      JSONL log — the side-band built for exactly this, readable on
  //      the dev machine without the phone's cooperation.
  function kbSnapshot() {
    const vv = window.visualViewport;
    return {
      ih: Math.round(window.innerHeight),
      vvh: vv ? Math.round(vv.height) : -1,
      vvot: vv ? Math.round(vv.offsetTop) : -1,
      vvpt: vv ? Math.round(vv.pageTop) : -1,
      sy: Math.round(window.scrollY),
      inset: document.documentElement.style.getPropertyValue("--kb-inset") || "(unset)",
      vvTopY: document.documentElement.style.getPropertyValue("--vv-top-y") || "(unset)",
      vvBottomY:
        document.documentElement.style.getPropertyValue("--vv-bottom-y") || "(unset)",
      cls: document.documentElement.classList.contains("keyboard-open"),
    };
  }
  let kbDebug = $state(false);
  let dbg = $state(kbSnapshotInit());
  function kbSnapshotInit() {
    return {
      ih: 0,
      vvh: 0,
      vvot: 0,
      vvpt: 0,
      sy: 0,
      inset: "",
      vvTopY: "",
      vvBottomY: "",
      cls: false,
    };
  }
  $effect(() => {
    if (!window.location.search.includes("kbdebug")) return;
    kbDebug = true;
    const upd = () => (dbg = kbSnapshot());
    upd();
    const i = setInterval(upd, 250);
    return () => clearInterval(i);
  });
  $effect(() => {
    if (!import.meta.env.DEV || readonly) return;
    let timers: ReturnType<typeof setTimeout>[] = [];
    const post = (phase: string) => {
      const composer = inputEl?.getBoundingClientRect();
      void fetch("/api/_diag/client-error", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "kbdebug",
          message: JSON.stringify({
            phase,
            ...kbSnapshot(),
            composerTop: composer ? Math.round(composer.top) : -1,
            composerBottom: composer ? Math.round(composer.bottom) : -1,
          }),
          userAgent: navigator.userAgent,
        }),
      }).catch(() => undefined);
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!isTextEntryElement(e.target as Element | null)) return;
      for (const t of timers) clearTimeout(t);
      timers = [120, 600, 1500].map((ms) =>
        setTimeout(() => post(`+${ms}ms`), ms),
      );
    };
    // Also snapshot ~400ms after viewport activity settles while a
    // field is focused — captures the scrolled-with-keyboard-up states
    // the focus-relative probes miss.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const onVvActivity = () => {
      if (!isTextEntryElement(document.activeElement)) return;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => post("vv-settle"), 400);
    };
    const vvDbg = window.visualViewport;
    document.addEventListener("focusin", onFocusIn);
    vvDbg?.addEventListener("resize", onVvActivity);
    vvDbg?.addEventListener("scroll", onVvActivity);
    window.addEventListener("resize", onVvActivity);
    return () => {
      for (const t of timers) clearTimeout(t);
      clearTimeout(settleTimer);
      document.removeEventListener("focusin", onFocusIn);
      vvDbg?.removeEventListener("resize", onVvActivity);
      vvDbg?.removeEventListener("scroll", onVvActivity);
      window.removeEventListener("resize", onVvActivity);
    };
  });

  // Soft-keyboard open shrinks the visual viewport; if the user was
  // pinned to the bottom, keep them there so the keyboard doesn't hide
  // the conversation tail. STRICTLY limited to the keyboard-OPEN
  // transition: only within REPIN_WINDOW_MS after a text field gains
  // focus. iOS 26 Safari also fires viewport resizes while SCROLLING
  // with the keyboard up (its layout viewport flips reporting modes
  // mid-gesture — see keyboard-inset.ts); an unwindowed re-pin turned
  // each of those into a scrollToBottom() that yanked the viewport out
  // from under the user's finger ("scrolling suddenly snaps to the
  // bottom"). The write re-checks the pin at landing time, as every
  // deferred write here does.
  const REPIN_WINDOW_MS = 1600;
  $effect(() => {
    if (readonly) return;
    const vv = window.visualViewport;
    if (!vv) return;
    let cancel: (() => void) | null = null;
    let focusedAt = -Infinity;
    const onFocusIn = (e: FocusEvent) => {
      if (isTextEntryElement(e.target as Element | null)) {
        focusedAt = performance.now();
      }
    };
    const onVvResize = () => {
      if (!isTextEntryElement(document.activeElement)) return;
      if (performance.now() - focusedAt > REPIN_WINDOW_MS) return;
      if (!chat.pinnedToBottom) return;
      cancel?.();
      cancel = afterNextPaint(() => {
        cancel = null;
        if (chat.pinnedToBottom) scrollToBottom();
      });
    };
    document.addEventListener("focusin", onFocusIn);
    vv.addEventListener("resize", onVvResize);
    // The layout viewport can resize with no vv event (iOS 26 bottom-bar
    // Safari resizes it at keyboard-animation end) — same gates.
    window.addEventListener("resize", onVvResize);
    return () => {
      cancel?.();
      document.removeEventListener("focusin", onFocusIn);
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
      // Inner-scroller edition: the reference line is the SCROLLER's top
      // edge (not the viewport's 0), since content above it is clipped
      // by the scroller, not the viewport. First bubble whose bottom is
      // still at/below that line — the topmost one the user can see.
      const refTop = root.getBoundingClientRect().top;
      const bubbles = root.querySelectorAll<HTMLElement>("[data-msg-id]");
      for (const el of bubbles) {
        const r = el.getBoundingClientRect();
        if (r.bottom > refTop) {
          anchorEl = el;
          anchorOffset = r.top;
          return;
        }
      }
      anchorEl = null;
    }

    snapshotAnchor();
    // The inner scroller fires `scroll` at the element; onChatScroll
    // binds to it (window fallback before the scroller is set).
    const unbindScroll = onChatScroll(snapshotAnchor);

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
      unbindScroll();
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

{#if kbDebug}
  <!-- ?kbdebug HUD (docs/mobile-ux.md): live tracker inputs/outputs,
       used to verify on-device keyboard geometry (esp. the PWA, which
       can't be tested over the insecure-HTTP LAN dev origin). -->
  <div class="kb-debug" aria-hidden="true">
    <div>--vv-top-y: {dbg.vvTopY}</div>
    <div>innerH: {dbg.ih}</div>
    <div>vv.h: {dbg.vvh}</div>
    <div>vv.offTop: {dbg.vvot}</div>
    <div>vv.pageTop: {dbg.vvpt}</div>
    <div>scrollY: {dbg.sy}</div>
    <div>--kb-inset: {dbg.inset}</div>
    <div>--vv-bottom-y: {dbg.vvBottomY}</div>
    <div>kb-open: {dbg.cls}</div>
  </div>
{/if}

<aside class="chat-sidebar-floating">
  <Sidebar />
</aside>

<!-- ADR-041: a fixed column sized to the visual viewport. The transcript
     is a real inner scroller (overflow-y:auto, full-bleed under the
     translucent bars); the composer and pills are overlays within the
     column. When the keyboard opens, only the column HEIGHT shrinks (to
     --vv-bottom-y) and the composer re-lays-out above the keyboard — no
     per-frame visual-viewport chasing, so no keyboard-up scroll
     stutter. Pills are absolutely positioned within this column. -->
<div class="chat-viewport">
  <div class="chat-transcript" bind:this={transcriptEl}>
    {#if !readonly}
      <div class="transcript-push-spacer" aria-hidden="true"></div>
    {/if}
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
      onWindowSlide={() => notifyListMutation()}
      scrollRoot={transcriptEl} />
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

  <!-- FRI-156 §E: sticky "Viewing pre-compaction history" pill. Shown when
       the user is scrolled above the most-recent compaction divider
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

  {#if !readonly}
    <div class="chat-input-floating" bind:this={inputEl}>
      <ChatInput />
    </div>
  {/if}
</div>

<!-- FIX_FORWARD 6.1: transient toast surfaced by /jump and other client-
     side commands. Auto-dismisses via chat.setToast(message, level, ms). -->
{#if !readonly && chat.toast}
  <div class="toast toast-{chat.toast.level}" role="status" aria-live="polite">
    {chat.toast.message}
  </div>
{/if}

<style>
  .chat-viewport,
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

  /* ADR-041: the chat column. A position:fixed box that
     spans the FULL viewport height (under the floating header, over the
     floating composer) so the inner scroller can bleed content beneath
     both translucent bars — preserving the glassmorphism where chat
     content is visible-but-blurred behind them. It is the containing
     block for the scroller, composer, and pills (all absolute within). */
  .chat-viewport {
    position: fixed;
    top: 0;
    left: var(--content-left);
    /* Right edge at the WINDOW edge (not inset by --page-gutter) so the inner
       scroller's scrollbar paints at the screen edge and the full right gutter
       is scroll-reactive, as if the whole page scrolled rather than an inset
       box. The scroller stays a plain inset:0 child (see .chat-transcript);
       the composer + pills re-inset themselves by --page-gutter to hold their
       prior position. */
    right: 0;
    /* Height tracks the VISUAL viewport bottom in every state — the
       tracker keeps --vv-bottom-y current whether the keyboard is up or
       not. Closed, this lands the column bottom (and the composer) above
       the iOS bottom URL bar; open, above the keyboard. The composer
       rides this purely by layout — no per-frame scroll-thread chase, so
       no stutter. (100dvh is the pre-hydration / desktop fallback.) */
    height: var(--vv-bottom-y, 100dvh);
    z-index: 40;
  }

  /* The inner scroller fills the column edge-to-edge and is the ONLY
     scroller on the chat route (body is locked — .chat-scroll-lock). Its
     padding-top / padding-bottom reserve the header and composer bands
     so content RESTS in the clear but SCROLLS UNDER the translucent bars
     (the under-glass effect). overflow-anchor:none keeps the browser's
     native scroll-anchoring off the manual `.list` anchor-restore math;
     overscroll-behavior:contain keeps iOS rubber-band off the locked
     body — the touch-routing fight ADR-039 fled can't happen because the
     body cannot scroll at all. */
  /* Full-width scrollbar (FRI chat): the column now reaches the window's right
     edge (.chat-viewport right:0), so the scrollbar paints at the screen edge
     and the whole right gutter is scroll-reactive. The scroller stays a plain
     `inset:0` child of the fixed column — exactly the geometry that has always
     shipped — and `padding-right: --page-gutter` re-insets content so every
     block keeps its prior horizontal position; only the scrollbar and reactive
     area move. DO NOT make this scroller overflow the fixed column (e.g. a
     negative `right` inset to reach the edge directly): on iOS Safari a
     scroller that spills past its position:fixed containing block silently
     breaks the IntersectionObserver-driven older-message pagination (the top
     sentinel stops firing). Widen the parent instead. */
  .chat-transcript {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-anchor: none;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    padding-top: var(--chat-top);
    padding-right: var(--page-gutter);
    padding-bottom: calc(
      var(--chat-input-h, 6rem) + 2 * var(--chat-inset) + var(--kb-safe-bottom, 0px)
    );
  }
  .transcript-push-spacer {
    flex-shrink: 0;
    height: max(0px, calc(var(--vv-top-y, 0px) - var(--chat-top, 0px)));
  }
  /* ?kbdebug HUD. Anchored to the top so
     it stays readable regardless of keyboard/composer state. */
  .kb-debug {
    position: fixed;
    top: 30%;
    left: 0.5rem;
    z-index: 9999;
    pointer-events: none;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    color: #0f0;
    background: rgba(0, 0, 0, 0.75);
    padding: 0.4rem 0.6rem;
    border-radius: 6px;
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

  /* Composer: a translucent overlay anchored to the column bottom (the
     scroller's padding-bottom reserves its band so content rests above
     it but scrolls under its frosted glass). No keyboard JS — the column
     height shrinks on keyboard-open and the composer rides the new
     bottom. z-index above the scroller content it floats over. */
  .chat-input-floating {
    position: absolute;
    bottom: calc(1rem + var(--kb-safe-bottom, 0px));
    left: 0;
    /* Re-inset by one gutter: the column now reaches the window edge, but the
       composer holds its prior right margin. */
    right: var(--page-gutter);
    z-index: 2;
    background: var(--header-float-bg);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    backdrop-filter: blur(20px) saturate(160%);
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

  /* ADR-041: pills are absolutely positioned WITHIN
     .chat-viewport (its containing block), so they ride the column as it
     resizes with the keyboard — no per-pill visual-viewport math. The
     jump pill sits just above the in-flow composer (composer height +
     gap); the top pills sit just under the column top. */
  .jump-to-bottom-wrap {
    position: absolute;
    bottom: calc(var(--chat-input-h, 6rem) + 1.5rem + var(--kb-safe-bottom, 0px));
    left: 0;
    /* Re-inset by one gutter so the centered pill keeps its prior center now
       that the column reaches the window edge. */
    right: var(--page-gutter);
    display: flex;
    justify-content: center;
    pointer-events: none;
    z-index: 95;
  }
  /* Top pills clear the floating header (the column starts at y=0, under
     it). --chat-top puts them in the clear band below the header. */
  .loading-older {
    position: absolute;
    top: calc(var(--chat-top) + 0.5rem);
    left: 0;
    right: var(--page-gutter);
    margin: 0 auto;
    width: max-content;
    z-index: 95;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  /* FRI-156 §E: pre-compaction pill at the top of the chat area, stacked
     below .loading-older so they don't overlap when both surface. */
  .pre-compaction-wrap {
    position: absolute;
    top: calc(var(--chat-top) + 3rem);
    left: 0;
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
    /* Mobile: full-width column (still full-bleed top:0). The scroller's
       padding-top clears BOTH the header and the mobile sidebar trigger
       row (which sits at --chat-top spanning gutter-to-gutter), so chat
       content rests below them but still scrolls under. */
    .chat-viewport {
      left: var(--page-gutter);
      /* Edge-to-edge on the right here too — scrollbar at the screen edge,
         composer/pills still re-inset by --page-gutter (base rule). */
      right: 0;
    }
    .chat-transcript {
      padding-top: calc(var(--chat-top) + 3.25rem);
    }
    .loading-older {
      top: calc(var(--chat-top) + 3.75rem);
    }
    .pre-compaction-wrap {
      top: calc(var(--chat-top) + 6.25rem);
    }
  }

  @media (max-width: 640px) {
    .chat-input-floating {
      bottom: calc(0.5rem + var(--kb-safe-bottom, 0px));
    }
    .jump-to-bottom-wrap {
      bottom: calc(var(--chat-input-h, 6rem) + 1rem + var(--kb-safe-bottom, 0px));
    }
  }
</style>
