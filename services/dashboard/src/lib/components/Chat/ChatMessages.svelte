<script lang="ts">
  import { tick, untrack } from "svelte";
  import { chat, type ChatMessage } from "$lib/stores/chat.svelte";
  import { chatInputBridge } from "$lib/stores/chat-input-bridge.svelte";
  import { clock } from "$lib/stores/clock.svelte";
  import { zeroSync } from "$lib/stores/zero.svelte";
  import { computeGroupingMeta } from "$lib/util/chat-grouping";
  import {
    isViewingPreCompaction,
    isViewingPreCompactionUnmounted,
  } from "$lib/components/Chat/compaction-render";
  import { fmtTokensCompact } from "$lib/util/format";
  import {
    formatAbsoluteTooltip,
    formatCompactingElapsed,
    formatDaySeparator,
    formatRelativeTime,
  } from "$lib/util/time-format";
  import Markdown from "$lib/components/Markdown/Markdown.svelte";
  import ToolBlock from "$lib/components/Chat/ToolBlock.svelte";
  import { friendlyToolName } from "$lib/components/Chat/tool-headlines";
  import { resolveToolRenderer } from "$lib/components/Chat/tool-renderers";
  import { stopFooter } from "$lib/components/Chat/stop-footer";
  import ThinkingBlock from "$lib/components/Chat/ThinkingBlock.svelte";
  import StreamingBall from "$lib/components/Chat/StreamingBall.svelte";
  import MailBlock from "$lib/components/Chat/MailBlock.svelte";
  import ErrorBlock from "$lib/components/Chat/ErrorBlock.svelte";
  import { X } from "lucide-svelte";

  function discardOne(queueId: string) {
    chat.discardPending(queueId);
  }

  function discardAll() {
    chat.discardAllPending();
  }

  /**
   * Yank a daemon-side queued turn (one parked in the worker's
   * `nextPrompts` FIFO, distinct from the client-side send-queue) and
   * stuff the recovered text back into the input bar. The cancel endpoint
   * returns the original prompt verbatim; ChatInput's bridge sink prepends
   * it and parks the caret at the end of the recovered text.
   *
   * If the daemon returns null (network failure or 409 — worker drained
   * the queue between render and click), leave the bubble in place. The
   * subsequent turn_started + block_meta_update events will flip it to
   * streaming on their own.
   */
  async function cancelDaemonQueued(turnId: string | undefined) {
    if (!turnId) return;
    // FRI-123: legacy REST fallback (`chat.cancelQueued`) deleted
    // along with the retired `DELETE /api/chat/turn/<id>/queued`
    // route — the fallback only fired when `useZero()` returned
    // false, which is never true in the browser. The cancelQueued
    // mutator + `/api/internal/cancel-queued` fast-path is the only
    // path.
    const recovered = await zeroSync.cancelQueued(turnId);
    if (recovered === null) return;
    if (recovered) chatInputBridge.prepend(recovered);
  }

  interface Props {
    /** When provided, this is a read-only past-session view; no SSE wiring,
     * no live-mode store reads. */
    messages?: ChatMessage[];
    /** Read-only loading flag. While true, render skeleton instead of empty
     * hero. Wired up by ChatShell when fetching a past session. */
    pastLoading?: boolean;
    /** Read-only error message. When set with an empty list, render a Retry
     * banner instead of the empty hero. */
    pastError?: string | null;
    /** Called by the Retry button in read-only mode. */
    onRetryPast?: () => void;
    /** FIX_FORWARD 3.7: read-only top-sentinel callback. Past-session view
     * paginates older blocks via /api/agents/:name/blocks?before=…. */
    onLoadOlderPast?: () => Promise<void> | void;
    /** When true, no older past blocks remain — the top sentinel doesn't
     * fire any more loads (FIX_FORWARD 3.7). */
    pastReachedOldest?: boolean;
    /** Active flag for the past-page-load — drives the "Loading older…"
     * pill so the user knows the scroll-up triggered something. */
    loadingOlderPast?: boolean;
    /** FRI-160: notifies ChatShell's single anchor-restore owner after a
     * window slide's DOM has settled. Load-bearing — a slide mounts and
     * unmounts the same bubble count, so `.list`'s net height change can
     * be ~0px and ChatShell's ResizeObserver alone never sees it. */
    onWindowSlide?: () => void;
  }
  let {
    messages,
    pastLoading = false,
    pastError = null,
    onRetryPast,
    onLoadOlderPast,
    pastReachedOldest = false,
    loadingOlderPast = false,
    onWindowSlide,
  }: Props = $props();
  let rawMessages = $derived(messages ?? chat.messages);
  let readonly = $derived(messages !== undefined);

  // Ticking clock for the compaction elapsed-time readout. The interval only
  // runs WHILE the focused agent is compacting (effect re-subscribes on the
  // `focusedAgentIsCompacting` edge) so there is no idle 1s timer otherwise.
  let compactingNowMs = $state(Date.now());
  $effect(() => {
    if (!chat.focusedAgentIsCompacting) return;
    compactingNowMs = Date.now();
    const id = setInterval(() => {
      compactingNowMs = Date.now();
    }, 1000);
    return () => clearInterval(id);
  });
  // "M:SS" elapsed since compaction began, from the durable `compacting_since`
  // column. Null while only the transient SSE signal is present (column not yet
  // replicated) — the label then renders without a timer until it lands.
  // Formatting + guards live in the pure, unit-tested `formatCompactingElapsed`.
  let compactingElapsedLabel = $derived(
    formatCompactingElapsed(chat.compactingSinceFor(chat.focusedAgent), compactingNowMs),
  );

  // FIX_FORWARD 2.6: pin pending bubbles to the bottom regardless of natural
  // sort. Extended to also pin user blocks the daemon recorded with
  // `status='queued'` — these are sitting in the worker's `nextPrompts`
  // FIFO behind an in-flight turn, and their stored `ts` is the POST time
  // (which would naturally sort them above the still-streaming assistant
  // blocks of the running turn). They unpin when the worker actually
  // dispatches them and the `block_meta_update` event flips status to
  // `complete` with a fresh `ts`.
  let allMessages = $derived.by(() => {
    if (readonly) return rawMessages;
    const isQueued = (m: (typeof rawMessages)[number]) =>
      m.pending || m.status === "queued";
    const nonQueued = rawMessages.filter((m) => !isQueued(m));
    const queued = rawMessages.filter(isQueued);
    return queued.length === 0 ? rawMessages : [...nonQueued, ...queued];
  });

  // Sliding-window DOM virtualization. The local replica holds the
  // entire 90-day history (plan §39 phase 2 background sync); the DOM
  // only ever holds a bounded slice of WINDOW_SIZE messages. As the
  // user scrolls toward either edge of the window, the slice slides:
  // we mount more on the side they're approaching and unmount the
  // same count on the opposite side. Net DOM size stays constant;
  // memory and layout cost are bounded regardless of how deep the
  // user scrolls.
  //
  // Sizing trade-off: WINDOW_SIZE bounds the maximum DOM nodes;
  // SLIDE_AMOUNT is how many we add/remove per slide. The sentinel's
  // rootMargin determines how close to the edge of the rendered list
  // a scroll has to reach before a slide fires — keep this generous
  // so the new content renders BEFORE the user's scroll actually
  // reaches the visual edge (otherwise they see "nothing more to
  // scroll" for the few frames it takes to mount the new batch).
  //
  // SLIDE_AMOUNT must be << WINDOW_SIZE so the slide keeps the user's
  // anchor bubble inside the new slice — otherwise the anchor lookup
  // in `slideWindow` returns null and the scroll-restore bails,
  // dropping the user at a disorienting scrollTop. 5:1 ratio gives
  // the anchor plenty of headroom.
  //
  // Past-session (read-only) views use the same WINDOW_SIZE cap so a
  // long session doesn't render thousands of DOM nodes on initial
  // paint — the cursor below is per-component and tracks the user's
  // scroll independently of the live `chat.chatWindowEnd` (which is
  // per-focused-agent and irrelevant to past-session navigation).
  const WINDOW_SIZE = 100;
  const SLIDE_AMOUNT = 20;
  // Readonly past-session cursor. `null` means "follow tail" — the
  // window starts at the last WINDOW_SIZE messages and `windowEnd`
  // tracks `allMessages.length` as `loadOlderPast` paginates older
  // bubbles in. Slide-up sets a concrete value; slide-down to tail
  // (where the cursor equals the length) resets to `null`.
  let readonlyWindowEnd = $state<number | null>(null);
  // `windowEnd` derives from chat.chatWindowEnd (live) or the local
  // readonly cursor (past-session view). Both have the same "null =
  // follow tail" convention so the slice logic below is unified.
  //
  // For live mode: chatWindowEnd is either null ("follow live tail")
  // or `{agent, end}` matching the focused agent. An agent-mismatch
  // also falls through to the tail, which handles agent-switch
  // cleanly (a stale window from the previous agent has no effect
  // on the new one).
  let windowEnd = $derived.by(() => {
    if (readonly) {
      return readonlyWindowEnd === null
        ? allMessages.length
        : Math.min(readonlyWindowEnd, allMessages.length);
    }
    if (chat.chatWindowEnd && chat.chatWindowEnd.agent === chat.focusedAgent) {
      return Math.min(chat.chatWindowEnd.end, allMessages.length);
    }
    return allMessages.length;
  });
  let windowStart = $derived(Math.max(0, windowEnd - WINDOW_SIZE));
  let list = $derived(allMessages.slice(windowStart, windowEnd));

  // Resolve the `--chat-top` header band (a `calc()`, so getPropertyValue
  // returns the literal expression) to a px number by measuring a transient
  // probe. Used as the negative top `rootMargin` for the pre-compaction pill
  // observer so a divider tucked under the floating header reads as out-of-view.
  //
  // The resolved value is effectively invariant for a session, but this helper
  // runs inside the pill `$effect`, which re-keys on every virtualization slide
  // and streaming block delta while a divider is in-window. Measuring a fresh
  // probe each time forces a synchronous DOM append/reflow/remove on that hot
  // path, so the result is memoized after the first measurement.
  let headerTopInsetCache: number | null = null;
  function headerTopInsetPx(): number {
    if (headerTopInsetCache !== null) return headerTopInsetCache;
    if (typeof document === "undefined") return 85;
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;visibility:hidden;height:var(--chat-top);";
    document.body.appendChild(probe);
    const h = probe.getBoundingClientRect().height;
    probe.remove();
    headerTopInsetCache = Number.isFinite(h) && h > 0 ? h : 85;
    return headerTopInsetCache;
  }
  // Honest "no older messages" gate: when windowStart hits 0 AND the
  // local replica is the canonical full set (Zero `resultType ===
  // 'complete'`), there is genuinely nothing older to slide to.
  // Flips `chat.reachedOldest` so the top-sentinel handler bails and
  // the "Beginning of history" affordance surfaces.
  $effect(() => {
    if (readonly) return;
    const ws = windowStart;
    const total = allMessages.length;
    const complete = zeroSync.blocksResultType === "complete";
    untrack(() => {
      // "Beginning of history" affordance fires only when the rendered
      // window genuinely starts at index 0 AND there are actual rows
      // AND Zero confirms the local replica matches the upstream filter
      // (no more rows the server has that the client hasn't seen).
      const atTop = ws === 0 && total > 0;
      if (complete && atTop) {
        if (!chat.reachedOldest) chat.reachedOldest = true;
      } else if (!atTop && chat.reachedOldest) {
        chat.reachedOldest = false;
      }
    });
  });

  // Slack-style grouping + separators (FRI-37). Computed off the same `list`
  // we render so windowing changes recompute it. Reading clock.now in the
  // template is enough for relative-time labels to update per-minute — the
  // grouping structure itself is purely a function of message ts/role/etc.
  // and never needs re-running on tick.
  //
  // `moreOlderHistoryPossible` suppresses the leading day separator while
  // pagination can still reveal older messages — otherwise the top of a
  // partially-loaded chat shows "Today" / "Yesterday" above a message that
  // is NOT actually the first of that day, just the first one we've
  // fetched. Once we reach the oldest block the leading separator pops in.
  let moreOlderHistoryPossible = $derived(
    readonly ? !pastReachedOldest : !chat.reachedOldest,
  );
  let groupingMeta = $derived(
    computeGroupingMeta(list, { moreOlderHistoryPossible }),
  );

  function timestampableMessage(msg: ChatMessage): boolean {
    // tool/thinking are continuations; they never carry their own timestamp.
    return msg.role !== "tool" && msg.role !== "thinking";
  }

  /**
   * Slide the windowEnd cursor. Viewport restoration is NOT computed
   * here: after the re-slice settles, `onWindowSlide` hands the
   * mutation to ChatShell's single anchor-restore owner (FRI-160),
   * which measures how far the user's topmost visible bubble moved and
   * queues one deferred window-scroll correction. The old
   * element-scroller code restored here with its own anchor math; that
   * can't survive alongside ChatShell's ResizeObserver restore — with
   * the writes deferred (double-rAF, doc-scroll.ts) the two would each
   * queue a full-height correction and double-apply. The hook (rather
   * than relying on the RO alone) is load-bearing in the other
   * direction too: a slide mounts SLIDE_AMOUNT bubbles on one edge and
   * unmounts the same count on the other, so `.list`'s NET height can
   * change by ~0px and the RO never fires at all.
   *
   * Direction:
   *   - "up"   → reveal older. Decreases windowEnd, shifting the
   *              slice toward the head of allMessages. New bubbles
   *              mount ABOVE the existing ones; oldest of the prior
   *              window unmount from the BOTTOM. DOM stays bounded.
   *   - "down" → reveal newer. Increases windowEnd. Symmetric: new
   *              bubbles mount BELOW, oldest unmount from the TOP.
   */
  function slideWindow(direction: "up" | "down"): void {
    const current = windowEnd;
    const newEnd =
      direction === "up"
        ? Math.max(WINDOW_SIZE, current - SLIDE_AMOUNT)
        : Math.min(allMessages.length, current + SLIDE_AMOUNT);
    // When a slide-down brings us back to the tail, drop the tagged
    // state so subsequent appends auto-extend without another mutator
    // hop. Read-only uses a component-local cursor; live shares the
    // per-focused-agent state on the chat store.
    if (readonly) {
      readonlyWindowEnd = newEnd === allMessages.length ? null : newEnd;
    } else if (newEnd === allMessages.length) {
      chat.chatWindowEnd = null;
    } else {
      chat.chatWindowEnd = { agent: chat.focusedAgent, end: newEnd };
    }

    // Hand the mutation to the restore owner once the new slice is in
    // the DOM. tick() resolves after Svelte's flush but before the
    // browser's RO delivery, so the hook measures first and the RO —
    // if the net height did change — measures a delta of 0 against the
    // shared, eagerly-advanced anchor. Order is safe in both worlds.
    void (async () => {
      await tick();
      onWindowSlide?.();
    })();
  }

  // Top-sentinel pagination. When the user scrolls up to the top of the
  // chat, the sentinel comes into view and we fetch the next 50 older
  // blocks from /api/agents/:name/blocks?before=…. Read-only / past-session
  // mode uses its own messages array (passed in via `messages` prop) and
  // doesn't paginate — those views show a single fixed session.
  let topSentinel: HTMLDivElement | undefined = $state();
  // Bottom sentinel. An IntersectionObserver tracks whether the bottom of
  // the chat is in view (within 200px); the result drives chat.pinnedToBottom
  // which gates auto-scroll, the jump-to-latest button, and the DOM-cap
  // window slice. Replaces the previous scroll-position math in ChatShell.
  let bottomSentinel: HTMLDivElement | undefined = $state();
  // Track the live top-sentinel IntersectionObserver so a sibling effect
  // can force it to re-emit its current intersection state when pagination
  // state transitions allow a previously-bailed callback to succeed.
  let topSentinelObserver: IntersectionObserver | null = null;

  $effect(() => {
    if (!topSentinel) return;
    const el = topSentinel;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          // FIX_FORWARD 3.7: past-session paginates older blocks too.
          if (readonly) {
            // Slide the window up within the already-loaded past-session
            // array first — no need to hit the network if the older
            // blocks are already in the messages prop. Falls through
            // to onLoadOlderPast only when we've slid all the way to
            // the head AND the parent says more pages remain.
            if (windowStart > 0) {
              slideWindow("up");
              continue;
            }
            if (!onLoadOlderPast || pastReachedOldest || loadingOlderPast)
              continue;
            // Older-page prepend: no viewport restore here either —
            // the prepended rows resize `.list` and ChatShell's
            // ResizeObserver (the single anchor-restore owner) queues
            // the one deferred correction. See slideWindow.
            void Promise.resolve(onLoadOlderPast());
            continue;
          }
          // Slide the window UP (reveal older). No-op when already at
          // the start of history or when there's nothing more to slide
          // toward. The Zero local replica already holds the older
          // messages we're about to mount — there is no network call.
          if (windowStart === 0) continue;
          slideWindow("up");
        }
      },
      // Generous top margin: fire the slide BEFORE the user's scroll
      // actually reaches the top edge of the rendered DOM so the new
      // batch has time to mount + anchor-restore in. Without this
      // headroom the user briefly sees a hard stop at the top while
      // the new chunk renders.
      { rootMargin: "600px 0px 0px 0px" },
    );
    obs.observe(el);
    topSentinelObserver = obs;
    return () => {
      obs.disconnect();
      if (topSentinelObserver === obs) topSentinelObserver = null;
    };
  });

  // Force the top-sentinel IntersectionObserver to re-emit a callback
  // when state transitions make pagination newly possible. IO callbacks
  // only fire on intersection CHANGES; if the sentinel was already in
  // view when a guard was active (e.g. switching from a small chat
  // where `reachedOldest=true` made the previous callback a no-op),
  // it won't re-fire on its own after state clears. For chats whose
  // content fits in one viewport the user can't scroll to nudge it
  // either — so pagination would silently never trigger.
  //
  // Unobserve + re-observe forces an immediate fresh callback with the
  // current intersection state. If the sentinel is in view, the IO
  // callback runs against now-current guards and fires `loadOlder`. If
  // it's out of view (content > viewport), the re-observe is a no-op
  // and the user's next scroll-up will trigger pagination normally.
  $effect(() => {
    if (readonly) return;
    // Track the gates the new local-first callback checks. The IO only
    // emits on intersection CHANGES — without a forced re-emit, a small
    // chat whose entire list fits in one viewport (so the top sentinel
    // is already intersecting when render-take is at the WINDOW_SIZE
    // floor) never triggers an expansion no matter how many older rows
    // arrive into the local replica afterward.
    //
    // We deliberately do NOT track `allMessages.length` directly to
    // avoid the historical "every send re-emits the IO and trips a
    // spurious expansion" regression — instead we track the agent
    // identity (covers agent-switch) and reachedOldest (covers the
    // window-just-caught-up-to-all-messages transition flipping the
    // gate state).
    chat.focusedAgent;
    chat.reachedOldest;

    untrack(() => {
      if (chat.reachedOldest) return;
      if (!topSentinelObserver || !topSentinel) return;
      topSentinelObserver.unobserve(topSentinel);
      topSentinelObserver.observe(topSentinel);
    });
  });

  $effect(() => {
    if (!bottomSentinel) return;
    const sentinel = bottomSentinel;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const atBottomOfWindow = e.isIntersecting;
          // `pinnedToBottom` is a live-only signal (it gates auto-scroll
          // on streaming deltas in ChatShell). Past-session views don't
          // have live appends, so they leave it alone.
          if (!readonly) {
            // "user is viewing the live tail of history" — at the bottom
            // of the rendered window AND that window's end is the end
            // of all messages. With the sliding window, "at bottom of
            // rendered" alone is not enough: it might just mean "at the
            // bottom of the slice we currently have mounted, with more
            // newer messages waiting to slide in."
            chat.pinnedToBottom =
              atBottomOfWindow && windowEnd >= allMessages.length;
          }
          // Symmetric slide-down: when the user reaches the bottom of
          // the rendered window AND there are newer messages beyond it
          // (e.g., they scrolled up earlier, were mid-history, now
          // scrolling back down), advance the window. Anchor restore
          // keeps their viewport pinned through the mount. Same trigger
          // in both modes — the slide writes to readonlyWindowEnd or
          // chat.chatWindowEnd depending on mode.
          if (atBottomOfWindow && windowEnd < allMessages.length) {
            slideWindow("down");
          }
        }
      },
      // Match the old scroll-math threshold: treat "within 200px of the
      // bottom" as pinned. The slide-down trigger uses the same
      // intersection so the window starts mounting newer messages
      // ~200px before the user's scroll actually reaches the visual
      // bottom — same headroom strategy as the top-sentinel.
      { rootMargin: "0px 0px 200px 0px" },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  });

  // FIX_FORWARD 6.1: scroll target. Date and term jumps both write to
  // `chat.scrollTarget` (a nonce-keyed `{id, nonce}`). The nonce changes
  // on every request so re-jumping to the same bubble id still triggers
  // a fresh scrollIntoView. Highlight pulse — when applicable — comes
  // from a separate `chat.highlightedMessageId` and is cleared by
  // ChatInput on the next keystroke (not on a timer).
  $effect(() => {
    if (readonly) return;
    const target = chat.scrollTarget;
    if (!target) return;
    queueMicrotask(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-msg-id="${CSS.escape(target.id)}"]`,
      );
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });

  // FRI-156 §E: "Viewing pre-compaction history" pill detection. The pill
  // shows when the user is scrolled ABOVE the most-recent compaction divider.
  //
  // The divider id is derived over ALL messages, but the DOM only mounts the
  // windowed slice, so the divider can be UNMOUNTED in both directions:
  //   - above the window (user scrolled down into recent / live-tail content)
  //   - below the window (user scrolled up into older pre-compaction history)
  // Treating "element absent" as "necessarily pre-compaction" was a false
  // positive at the tail of a long, frequently-compacted session (the divider
  // falls above windowStart while the user is pinned to the bottom). Instead
  // we compare the divider's index in allMessages against the window:
  //   - index >= windowEnd  → divider is below the rendered slice → every
  //                           rendered message is OLDER → user is above it →
  //                           pill ON.
  //   - index <  windowStart → divider is above the slice → every rendered
  //                           message is NEWER → user is necessarily BELOW it
  //                           (post-compaction tail) → pill OFF, regardless of
  //                           pinned state.
  //   - in-window           → observe the element and use the pure geometry
  //                           helper (`isViewingPreCompaction`).
  //
  // Re-keys on the divider id and the window bounds (NOT the whole `list`
  // array, which changes identity on every block delta while a turn streams —
  // that thrashed the observer per token). The IntersectionObserver carries a
  // negative top `rootMargin` equal to the header height so a divider tucked
  // UNDER the floating header (visually hidden but still geometrically
  // intersecting) is treated as out-of-view, matching the other sentinels.
  $effect(() => {
    if (readonly) {
      chat.viewingPreCompaction = false;
      return;
    }
    const dividerId = chat.latestCompactionDividerId;
    if (!dividerId) {
      chat.viewingPreCompaction = false;
      return;
    }
    // Re-key on the window bounds so a slide that mounts/unmounts the divider
    // re-runs this effect — but NOT on `list` identity (per-token churn).
    const start = windowStart;
    const end = windowEnd;
    const dividerIdx = allMessages.findIndex((m) => m.id === dividerId);
    if (dividerIdx === -1) {
      chat.viewingPreCompaction = false;
      return;
    }
    if (dividerIdx >= end || dividerIdx < start) {
      // Divider is unmounted (above or below the rendered slice). The pill state
      // is a pure function of index-vs-window — see the helper's doc-comment:
      //   - below the slice (>= end) → user is above it → pill ON.
      //   - above the slice (< start) → every rendered message is NEWER than the
      //     divider → user is necessarily BELOW it (post-compaction tail) → pill
      //     OFF, regardless of pinned state.
      chat.viewingPreCompaction = isViewingPreCompactionUnmounted({
        dividerIdx,
        windowStart: start,
        windowEnd: end,
      });
      return;
    }
    // In-window: observe the actual element and use the shared geometry helper.
    const el = document.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(dividerId)}"]`);
    if (!el) {
      // Index says in-window but the node hasn't painted yet — fall back to the
      // not-pinned heuristic rather than a hard true.
      chat.viewingPreCompaction = !chat.pinnedToBottom;
      return;
    }
    const headerInset = headerTopInsetPx();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const rootBottom = e.rootBounds?.bottom ?? window.innerHeight;
          chat.viewingPreCompaction = isViewingPreCompaction({
            dividerTop: e.boundingClientRect.top,
            viewportBottom: rootBottom,
            isIntersecting: e.isIntersecting,
          });
        }
      },
      // Negative top inset: the region under the floating chat header is
      // treated as out-of-view so a divider occluded by the header still
      // reports as not-intersecting (matching the top/bottom sentinels).
      { threshold: 0, rootMargin: `${-headerInset}px 0px 0px 0px` },
    );
    obs.observe(el);
    return () => {
      obs.disconnect();
    };
  });
</script>

<div class="list">
  <div bind:this={topSentinel} class="top-sentinel" aria-hidden="true">
    {#if !readonly && chat.reachedOldest && list.length > 0}
      <span class="hint dim">Beginning of history</span>
    {:else if readonly && pastReachedOldest && list.length > 0 && windowStart === 0}
      <span class="hint dim">Beginning of session</span>
    {/if}
    <!-- The transient `loadingOlder` indicator now lives in ChatShell as a
         floating pill so it's actually visible while pagination runs;
         inline-here got missed because it was hidden in the same scroll
         zone the user just left. -->
  </div>
  {#if list.length === 0}
    {#if (!readonly && chat.loadingInitial) || (readonly && pastLoading)}
      <div class="skeleton-list" aria-hidden="true">
        <div class="skeleton-bubble assistant"></div>
        <div class="skeleton-bubble user"></div>
        <div class="skeleton-bubble assistant"></div>
      </div>
    {:else if !readonly && chat.historyError}
      <div class="error-banner" role="alert">
        <span class="error-msg">{chat.historyError}</span>
        <button
          type="button"
          class="retry-btn"
          onclick={() => chat.loadAgentTurns(chat.focusedAgent)}>
          Retry
        </button>
      </div>
    {:else if readonly && pastError}
      <div class="error-banner" role="alert">
        <span class="error-msg">{pastError}</span>
        {#if onRetryPast}
          <button type="button" class="retry-btn" onclick={() => onRetryPast?.()}>
            Retry
          </button>
        {/if}
      </div>
    {:else if readonly}
      <div class="empty">
        <h2>Empty session</h2>
        <p>This session has no recorded turns.</p>
      </div>
    {:else}
      <div class="empty">
        <h2>👑 Friday</h2>
        <p>Say hi or ask for what you want done.</p>
      </div>
    {/if}
  {/if}
  {#each list as msg, i (msg.id)}
    {@const meta = groupingMeta[i]}
    {#if meta?.showDaySeparator}
      <div class="day-separator" role="separator" aria-label={formatDaySeparator(msg.ts, clock.now)}>
        <span class="day-separator-label">{formatDaySeparator(msg.ts, clock.now)}</span>
      </div>
    {:else if meta?.showInactivitySeparator}
      <div class="inactivity-separator" role="separator"></div>
    {/if}
    {#if meta?.isFirstInGroup && timestampableMessage(msg)}
      <div
        class="msg-timestamp {msg.role === 'user' && msg.source !== 'mail' ? 'right' : 'left'}"
        title={formatAbsoluteTooltip(msg.ts)}>
        <time
          datetime={new Date(msg.ts).toISOString()}
          aria-label={formatAbsoluteTooltip(msg.ts)}>
          {formatRelativeTime(msg.ts, clock.now)}
        </time>
      </div>
    {/if}
    {#if msg.kind === "no-response"}
      <!-- FRI-85: the model emitted its trained "No response requested."
           end-of-turn marker (noResponseSentinel=true), or the turn
           finished with no assistant content at all (noResponseSentinel=
           false). Render a faint inline note so the user is never left
           staring at their own message wondering whether the system
           swallowed the turn. -->
      <div
        class="message inline"
        class:jump-highlight={!readonly && chat.highlightedMessageId === msg.id}
        onanimationend={(e: AnimationEvent) => {
          if (e.animationName === "jump-pulse" && chat.highlightedMessageId === msg.id) {
            chat.highlightedMessageId = null;
          }
        }}
        data-msg-id={msg.id}
        data-kind="no-response">
        <div class="no-response">
          {msg.noResponseSentinel
            ? "Agent acknowledged — no reply needed"
            : msg.zeroBlockReason === "abort"
              ? "Stopped"
              : msg.zeroBlockReason === "compaction"
                ? "Compacted — no response"
                : "Agent didn't respond"}
        </div>
      </div>
    {:else if msg.kind === "error"}
      <div
        class="message inline"
        class:jump-highlight={!readonly && chat.highlightedMessageId === msg.id}
        onanimationend={(e: AnimationEvent) => {
          if (e.animationName === "jump-pulse" && chat.highlightedMessageId === msg.id) {
            chat.highlightedMessageId = null;
          }
        }}
        data-status="error"
        data-msg-id={msg.id}>
        <ErrorBlock
          headline={msg.errorHeadline ?? msg.text}
          code={msg.errorCode ?? "unknown"}
          ts={msg.ts}
          retryAfterSeconds={msg.retryAfterSeconds}
          httpStatus={msg.httpStatus}
          requestId={msg.requestId}
          rawMessage={msg.rawErrorMessage}
          canResend={!readonly && chat.canResendTurn(msg.turnId)}
          canResume={!readonly && chat.canResumeTurn(msg.turnId, msg.errorCode)}
          onResend={() => msg.turnId && chat.resendUserText(msg.turnId)}
          onResume={() => msg.turnId && chat.resumeTurn(msg.turnId)} />
      </div>
    {:else if msg.kind === "compaction"}
      <!-- FRI-156 §E: durable full-width compaction divider. Derived from a
           persisted kind:'compaction' block (parseBlocks → cb_<blockId>), so
           it survives reload — unlike the retired in-memory inline notice.
           NOT gated on `!readonly`: durability is the point, so the divider
           appears in past-session views too. `data-msg-id` lets the
           pre-compaction pill scroll to it via chat.scrollTarget. -->
      <div
        class="compaction-divider"
        role="separator"
        data-msg-id={msg.id}
        data-kind="compaction"
        aria-label={msg.preTokens != null && msg.postTokens != null
          ? `Context compacted from ${fmtTokensCompact(msg.preTokens)} to ${fmtTokensCompact(msg.postTokens)} tokens`
          : "Context compacted"}>
        <span class="compaction-divider-label">
          {#if msg.preTokens != null && msg.postTokens != null}
            Context compacted · {fmtTokensCompact(msg.preTokens)} → {fmtTokensCompact(
              msg.postTokens,
            )} tokens
          {:else}
            Context compacted
          {/if}
        </span>
      </div>
    {:else if msg.role === "tool"}
      <!-- FRI-130: route through the per-tool renderer registry. A
           registered renderer (TodoWrite/file-edit/mail — tickets A/B/C) is
           mounted via the runes-mode dynamic form; every unregistered tool
           falls back to the generic ToolBlock (today's behavior). The
           registry ships empty, so this `{:else}` is the only live path. -->
      {@const toolRenderer = resolveToolRenderer(msg.toolName ?? "")}
      <div class="message inline">
        {#if toolRenderer}
          {@const ToolRenderer = toolRenderer.component}
          <ToolRenderer
            toolName={msg.toolName ?? ""}
            friendlyName={friendlyToolName(msg.toolName ?? "")}
            status={(msg.status === "done" || msg.status === "error" || msg.status === "aborted" ? msg.status : "running") as "running" | "done" | "error" | "aborted"}
            input={msg.input}
            inputPartialJson={msg.inputPartialJson}
            output={msg.output}
            toolId={msg.toolId} />
        {:else}
          <ToolBlock
            toolName={msg.toolName ?? ""}
            friendlyName={friendlyToolName(msg.toolName ?? "")}
            status={(msg.status === "done" || msg.status === "error" || msg.status === "aborted" ? msg.status : "running") as "running" | "done" | "error" | "aborted"}
            input={msg.input}
            inputPartialJson={msg.inputPartialJson}
            output={msg.output} />
        {/if}
      </div>
    {:else if msg.role === "thinking"}
      <div class="message inline">
        <ThinkingBlock
          text={msg.text}
          status={msg.status === "done" ? "done" : msg.status === "aborted" ? "aborted" : msg.status === "error" ? "error" : "running"}
          isRedacted={msg.isRedacted}
          showBall={chat.ballInThinking} />
      </div>
    {:else if msg.role === "user" && msg.source === "mail"}
      <div
        class="message inline"
        class:jump-highlight={!readonly && chat.highlightedMessageId === msg.id}
        onanimationend={(e: AnimationEvent) => {
          if (
            e.animationName === "jump-pulse" &&
            chat.highlightedMessageId === msg.id
          ) {
            chat.highlightedMessageId = null;
          }
        }}
        data-status={msg.status}
        data-msg-id={msg.id}>
        <MailBlock
          fromAgent={msg.fromAgent ?? "unknown agent"}
          body={msg.text}
          meta={msg.mailMeta} />
      </div>
    {:else}
      <div
        class="message {msg.role}"
        class:jump-highlight={!readonly && chat.highlightedMessageId === msg.id}
        onanimationend={(e: AnimationEvent) => {
          // Self-clear the highlight state when the CSS pulse animation
          // completes. animationend bubbles up from the inner .bubble
          // element. Filter by name in case other animations are added
          // to this subtree later.
          if (
            e.animationName === "jump-pulse" &&
            chat.highlightedMessageId === msg.id
          ) {
            chat.highlightedMessageId = null;
          }
        }}
        data-status={msg.status}
        data-msg-id={msg.id}>
        <div class="bubble">
          {#if msg.role === "user"}
            <div class="text user-text">{msg.text}</div>
            {#if msg.attachments && msg.attachments.length > 0}
              <div class="attachments">
                {#each msg.attachments as a}
                  {#if a.mime.startsWith("image/")}
                    <a class="attachment-thumb" href={`/api/uploads/${a.sha256}`} target="_blank" rel="noopener">
                      <img src={`/api/uploads/${a.sha256}`} alt={a.filename} />
                    </a>
                  {:else}
                    <a class="attachment-chip" href={`/api/uploads/${a.sha256}`} target="_blank" rel="noopener">
                      📎 {a.filename}
                    </a>
                  {/if}
                {/each}
              </div>
            {/if}
            {#if msg.queueId && msg.failed}
              <div class="footer-tag failed-row">
                <span>Failed to send</span>
                <button type="button" class="queue-action" onclick={() => msg.queueId && discardOne(msg.queueId)}>Discard</button>
                <button type="button" class="queue-action" onclick={discardAll}>Discard all</button>
              </div>
            {:else if msg.queueId && msg.pending}
              <div class="footer-tag queued">Sending…</div>
            {:else if msg.status === "queued"}
              <!-- Daemon-side queue: this message is sitting in the
                   worker's `nextPrompts` FIFO behind an in-flight turn.
                   The X yanks it back and stuffs the text into the input
                   bar (chatInputBridge → ChatInput sink). -->
              <div class="footer-tag queued queued-row">
                <span>Queued — waiting for current turn</span>
                <button
                  type="button"
                  class="queue-cancel"
                  aria-label="Cancel queued message"
                  title="Cancel and edit"
                  onclick={() => cancelDaemonQueued(msg.turnId)}>
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            {/if}
            <!-- FRI-95: user-block is the always-present render surface
                 for the Stop affordance. Copy + classname come from the
                 pure `stopFooter` lookup so the contract is pinned at the
                 unit-test layer (`stop-footer.test.ts`). -->
            {@const userFooter = stopFooter(msg.status, msg.abortReason)}
            {#if userFooter}
              <div class="footer-tag {userFooter.className ?? ''}">{userFooter.text}</div>
            {/if}
          {:else}
            <Markdown source={msg.text} streaming={msg.status === "streaming"} />{#if chat.ballInText && msg.status === "streaming"}<StreamingBall />{/if}
            {@const assistantFooter = stopFooter(msg.status, msg.abortReason)}
            {#if assistantFooter}
              <div class="footer-tag {assistantFooter.className ?? ''}">{assistantFooter.text}</div>
            {:else if msg.status === "error"}
              <div class="footer-tag err">Error</div>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
  {/each}
  {#if !readonly && chat.focusedAgentIsCompacting}
    <!-- Compaction-in-progress indicator. Now reconstructable: driven by
         chat.focusedAgentIsCompacting, which unions the transient `compacting`
         SSE signal with the durable `agents.compacting_since` column — so it
         survives reload/reconnect and the daemon-restart window, not just the
         live SSE frame. The retired FRI-60 inline `.compaction-notice`
         (in-memory, per-turn, lost on reload) is superseded by the durable
         divider above; this is the live readout while compaction runs, and it
         hands off to that divider on completion. -->
    <div class="message inline" data-compacting="true">
      <div class="compacting-status" role="status" aria-live="polite">
        <span class="spinner" aria-hidden="true"></span>
        Compacting context…{#if compactingElapsedLabel}<span class="elapsed"
            >&nbsp;{compactingElapsedLabel}</span
          >{/if}
      </div>
    </div>
  {/if}
  {#if !readonly && chat.ballStandalone}
    <div class="message inline">
      <StreamingBall />
    </div>
  {/if}
  <div
    bind:this={bottomSentinel}
    class="bottom-sentinel"
    aria-hidden="true"
  ></div>
</div>

<style>
  .list {
    padding: 0 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .message {
    display: flex;
  }
  .message.user {
    justify-content: flex-end;
  }
  /* FIX_FORWARD 6.1: /jump match highlight. Bright outline that fades
     after ~2s — long enough for the user to see what was matched. */
  .message.jump-highlight :global(.bubble) {
    animation: jump-pulse 2s ease-out 1;
    border-radius: var(--radius-md);
  }
  @keyframes jump-pulse {
    0% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent-primary) 60%, transparent);
    }
    30% {
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent-primary) 25%, transparent);
    }
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent-primary) 0%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .message.jump-highlight :global(.bubble) { animation: none; }
  }
  .message.assistant {
    justify-content: flex-start;
  }
  .message.inline {
    display: block;
  }
  .bubble {
    max-width: 90%;
    padding: 0.75rem 1rem;
    border-radius: var(--radius-md);
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    word-wrap: break-word;
    box-shadow: var(--shadow-sm);
  }
  .message.user .bubble {
    background: var(--accent-primary);
    color: var(--text-inverse);
    border-color: var(--accent-primary);
  }
  .message.assistant .bubble {
    max-width: 100%;
    width: 100%;
    padding: 0;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
  }
  .user-text {
    white-space: pre-wrap;
    font-size: 0.9rem;
  }
  .footer-tag {
    font-size: 0.7rem;
    color: var(--text-tertiary);
    margin-top: 0.4rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
  }
  .footer-tag.err {
    color: var(--status-error);
  }
  .footer-tag.stopping {
    color: var(--status-warn);
  }
  .footer-tag.queued {
    color: var(--text-inverse);
    opacity: 0.85;
  }
  .footer-tag.queued-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .queue-cancel {
    background: rgba(255, 255, 255, 0.18);
    border: 1px solid rgba(255, 255, 255, 0.25);
    color: var(--text-inverse);
    width: 1.4rem;
    height: 1.4rem;
    padding: 0;
    border-radius: 999px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 0;
  }
  .queue-cancel:hover {
    background: rgba(255, 255, 255, 0.32);
  }
  .footer-tag.failed-row {
    color: var(--text-inverse);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }
  .queue-action {
    background: rgba(255, 255, 255, 0.18);
    border: 1px solid rgba(255, 255, 255, 0.25);
    color: var(--text-inverse);
    padding: 0.15rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.7rem;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .queue-action:hover {
    background: rgba(255, 255, 255, 0.28);
  }
  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.5rem;
  }
  .attachment-thumb {
    display: block;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: rgba(0, 0, 0, 0.15);
    line-height: 0;
  }
  .attachment-thumb img {
    max-width: 220px;
    max-height: 220px;
    display: block;
  }
  .attachment-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.6rem;
    background: rgba(255, 255, 255, 0.18);
    border-radius: var(--radius-sm);
    font-size: 0.8rem;
    color: var(--text-inverse);
    text-decoration: none;
    word-break: break-all;
  }
  .attachment-chip:hover {
    background: rgba(255, 255, 255, 0.28);
  }
  .empty {
    text-align: center;
    color: var(--text-secondary);
    margin-top: 4rem;
  }
  .empty h2 {
    color: var(--text-primary);
    font-size: 1.4rem;
    margin-bottom: 0.5rem;
  }
  .error-banner {
    margin: 4rem auto 0;
    max-width: 28rem;
    padding: 0.75rem 1rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    border: 1px solid var(--status-error);
    background: color-mix(in srgb, var(--status-error) 10%, transparent);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-size: 0.85rem;
  }
  .error-msg { flex: 1; }
  .retry-btn {
    background: var(--status-error);
    color: var(--bg-primary);
    border: none;
    padding: 0.35rem 0.85rem;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
  }
  .retry-btn:hover {
    filter: brightness(1.1);
  }
  .top-sentinel {
    min-height: 1px;
    text-align: center;
    padding: 0.5rem 0;
  }
  .bottom-sentinel {
    min-height: 1px;
  }
  .hint {
    font-size: 0.75rem;
    color: var(--text-tertiary);
  }
  .skeleton-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem 0;
  }
  .skeleton-bubble {
    height: 3.5rem;
    border-radius: var(--radius-md);
    background: linear-gradient(
      90deg,
      var(--bg-card) 0%,
      var(--bg-tertiary) 50%,
      var(--bg-card) 100%
    );
    background-size: 200% 100%;
    animation: skeleton-shimmer 1.4s linear infinite;
    max-width: 70%;
  }
  .skeleton-bubble.user {
    align-self: flex-end;
    width: 50%;
  }
  .skeleton-bubble.assistant {
    align-self: flex-start;
    width: 70%;
  }
  @keyframes skeleton-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  .hint.dim {
    opacity: 0.6;
  }
  .day-separator {
    display: flex;
    align-items: center;
    margin: 1.25rem 0 0.5rem;
    position: relative;
  }
  .day-separator::before,
  .day-separator::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border-subtle);
  }
  .day-separator-label {
    padding: 0.15rem 0.75rem;
    margin: 0 0.5rem;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: none;
    letter-spacing: 0;
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    background: var(--bg-card);
    white-space: nowrap;
  }
  .inactivity-separator {
    height: 1px;
    background: var(--border-subtle);
    margin: 0.75rem 0 0.25rem;
    opacity: 0.5;
  }
  .msg-timestamp {
    font-size: 0.7rem;
    color: var(--text-tertiary);
    margin-top: 0.15rem;
    line-height: 1;
  }
  .msg-timestamp.right {
    text-align: right;
  }
  .msg-timestamp.left {
    text-align: left;
  }
  .msg-timestamp time {
    cursor: default;
  }
  .no-response {
    font-size: 0.78rem;
    color: var(--text-tertiary);
    font-style: italic;
    padding: 0.35rem 0.5rem;
    opacity: 0.85;
  }
  /* FRI-156 §E: durable full-width compaction divider. Reuses the
     .day-separator idiom (centered pill flanked by hairlines) so it reads as
     a structural boundary in the transcript rather than a chat bubble. */
  .compaction-divider {
    display: flex;
    align-items: center;
    margin: 1.25rem 0 0.5rem;
    position: relative;
  }
  .compaction-divider::before,
  .compaction-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border-subtle);
  }
  .compaction-divider-label {
    padding: 0.15rem 0.75rem;
    margin: 0 0.5rem;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    background: var(--bg-card);
    white-space: nowrap;
  }
  /* "Compacting context…" live indicator (durable-backed, reconstructable). */
  .compacting-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.78rem;
    color: var(--text-tertiary);
    font-style: italic;
    padding: 0.35rem 0.5rem;
    opacity: 0.85;
  }
  /* Elapsed readout ("M:SS"). Tabular figures so the width doesn't jitter as
     the seconds tick. Not italic — it reads as a value, not prose. */
  .compacting-status .elapsed {
    font-style: normal;
    font-variant-numeric: tabular-nums;
  }
  .spinner {
    width: 0.85rem;
    height: 0.85rem;
    border: 2px solid var(--border-subtle);
    border-top-color: var(--accent-primary);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex: none;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
