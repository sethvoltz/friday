<script lang="ts">
  import { tick, untrack } from "svelte";
  import { chat, type ChatMessage } from "$lib/stores/chat.svelte";
  import { chatInputBridge } from "$lib/stores/chat-input-bridge.svelte";
  import { sendQueue } from "$lib/stores/send-queue.svelte";
  import Markdown from "$lib/components/Markdown/Markdown.svelte";
  import ToolBlock from "$lib/components/Chat/ToolBlock.svelte";
  import ThinkingBlock from "$lib/components/Chat/ThinkingBlock.svelte";
  import MailBlock from "$lib/components/Chat/MailBlock.svelte";
  import ErrorBlock from "$lib/components/Chat/ErrorBlock.svelte";
  import { X } from "lucide-svelte";

  function queueEntry(queueId: string | undefined) {
    if (!queueId) return undefined;
    return sendQueue.items.find((q) => q.id === queueId);
  }

  async function retryQueued(queueId: string) {
    const result = await sendQueue.retry(queueId);
    for (const s of result.sent) {
      chat.confirmPending(s.queueId, s.turnId);
      // See ChatInput's submit() for the gate rationale: a queued turn
      // must not displace the actively-streaming turn's inflight slot.
      if (!s.queued) chat.inflightTurnId = s.turnId;
    }
    for (const qid of result.failed) chat.markPendingFailed(qid);
    for (const qid of result.retrying) chat.markPendingRetrying(qid);
  }

  function discardOne(queueId: string) {
    sendQueue.remove(queueId);
    chat.discardPending(queueId);
  }

  function discardAll() {
    const ids = sendQueue.discardAll();
    for (const id of ids) chat.discardPending(id);
    // Defensive: any pending bubble that lost its queue entry mid-flight
    // should also be cleared.
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
    const recovered = await chat.cancelQueued(turnId);
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
  }
  let {
    messages,
    pastLoading = false,
    pastError = null,
    onRetryPast,
    onLoadOlderPast,
    pastReachedOldest = false,
    loadingOlderPast = false,
  }: Props = $props();
  let rawMessages = $derived(messages ?? chat.messages);
  let readonly = $derived(messages !== undefined);

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

  // DOM windowing. When the user is bottom-pinned (scrolled to or near the
  // latest), only render the last WINDOW_SIZE messages — keeps the DOM
  // bounded for long-running chats. The moment the user scrolls up to read
  // older history we render everything, including any pages already loaded
  // via top-sentinel pagination, so they can browse freely. Read-only
  // session views always render the full passed-in array.
  const WINDOW_SIZE = 200;
  let list = $derived.by(() => {
    if (readonly) return allMessages;
    // Defensive: while a load-older is in flight, never apply the
    // pinnedToBottom window slice. If the bottom IntersectionObserver
    // ever fires mid-mutation and flips `pinnedToBottom` true (the
    // observed WebKit paint bug had a different cause, but this guards
    // against a related theoretical race), the rendered DOM would chop
    // down to the last 200 items right as the user is reading older
    // history. Cheap to gate; keep it.
    if (chat.loadingOlder) return allMessages;
    if (!chat.pinnedToBottom) return allMessages;
    if (allMessages.length <= WINDOW_SIZE) return allMessages;
    return allMessages.slice(allMessages.length - WINDOW_SIZE);
  });

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
            if (!onLoadOlderPast || pastReachedOldest || loadingOlderPast)
              continue;
            const scroller = el.closest(".chat-scroll") as HTMLElement | null;
            const anchorEl =
              scroller?.querySelector<HTMLElement>("[data-msg-id]") ?? null;
            const anchorId = anchorEl?.getAttribute("data-msg-id") ?? null;
            const anchorOffset =
              anchorEl && scroller
                ? anchorEl.getBoundingClientRect().top -
                  scroller.getBoundingClientRect().top
                : 0;
            void Promise.resolve(onLoadOlderPast()).then(async () => {
              if (!scroller || !anchorId) return;
              await tick();
              if (!scroller) return;
              const target = scroller.querySelector<HTMLElement>(
                `[data-msg-id="${CSS.escape(anchorId)}"]`,
              );
              if (!target) return;
              const newOffset =
                target.getBoundingClientRect().top -
                scroller.getBoundingClientRect().top;
              const delta = newOffset - anchorOffset;
              // WebKit scroll-thread paint deferral fix — see the
              // matching block in the live-chat onPrepended below for
              // full rationale, including the re-entrancy note on why
              // we restore to "" instead of a snapshotted prev.
              scroller.style.overflowY = "hidden";
              scroller.scrollTop += delta;
              setTimeout(() => {
                if (scroller) scroller.style.overflowY = "";
              }, 0);
            });
            continue;
          }
          if (chat.loadingOlder || chat.reachedOldest) continue;
          // Anchor on a concrete rendered message rather than scrollHeight
          // math: capture the first currently-rendered bubble's id + its
          // distance from the viewport top, then after prepend, scroll so
          // that same bubble lands at the same offset. Works identically
          // in Chromium and WebKit; `scrollHeight - beforeHeight` did not
          // (WebKit's layout flush ordering left the read stale).
          const scroller = el.closest(".chat-scroll") as HTMLElement | null;
          const anchorEl =
            scroller?.querySelector<HTMLElement>("[data-msg-id]") ?? null;
          const anchorId = anchorEl?.getAttribute("data-msg-id") ?? null;
          const anchorOffset =
            anchorEl && scroller
              ? anchorEl.getBoundingClientRect().top -
                scroller.getBoundingClientRect().top
              : 0;
          void chat.loadOlderTurns({
            onPrepended: async () => {
              if (!scroller || !anchorId) return;
              // `tick()` flushes Svelte's pending DOM updates so the
              // freshly-prepended bubbles are in the document.
              await tick();
              if (!scroller) return;
              const target = scroller.querySelector<HTMLElement>(
                `[data-msg-id="${CSS.escape(anchorId)}"]`,
              );
              if (!target) return;
              const newOffset =
                target.getBoundingClientRect().top -
                scroller.getBoundingClientRect().top;
              const delta = newOffset - anchorOffset;
              // WebKit/Safari/Orion paint-deferral fix (virtua PR #862 /
              // inokawa#362, originally `prud/ios-overflow-scroll-to-top`).
              // A programmatic `scrollTop` write that lands while WebKit's
              // scroll thread is still hot (fast-scroll just stopped,
              // momentum, recent input) defers both the scroll commit and
              // the paint of the newly-revealed region until the next
              // user scroll event. The DOM is correct; the GPU paint is
              // stale. Toggling `overflow-y: hidden` synchronously detaches
              // the element from the scroll thread, forcing WebKit to
              // commit + flush a full paint. The async restore (setTimeout
              // 0) reattaches it correctly painted — a synchronous restore
              // reproduces the bug, so the tick is load-bearing.
              //
              // Re-entrancy: the restore targets "" (let .chat-scroll's
              // CSS overflow-y: auto resume), not a snapshotted prev. The
              // prepend's height change synchronously fires the ChatShell
              // content ResizeObserver, which calls its own writeScrollTop
              // mid-handler — before this setTimeout has run. With prev-
              // capture, that nested call would snapshot prev = "hidden"
              // and its trailing restore would re-apply "hidden", locking
              // the scroller permanently until the element unmounted (the
              // reported "have to switch session to recover" bug).
              scroller.style.overflowY = "hidden";
              scroller.scrollTop += delta;
              setTimeout(() => {
                if (scroller) scroller.style.overflowY = "";
              }, 0);
            },
          });
        }
      },
      { rootMargin: "200px 0px 0px 0px" },
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
    // Track the gates the callback checks. When any of these flips to a
    // pagination-permitting value, re-emit. `chat.focusedAgent` covers
    // agent-switch; `chat.oldestBlockId` transitions from null → string
    // when an initial load completes; the other two cover the small-chat
    // case where reachedOldest had been true on the previous agent.
    //
    // We deliberately do NOT track `chat.messages.length` here. That used
    // to be in the deps and produced a serious regression: every send
    // (`addUser` increments the length) re-emitted the IO callback, which
    // fired a spurious `loadOlderTurns` that — when it returned empty —
    // set `reachedOldest = true` and broke subsequent pagination.
    chat.focusedAgent;
    const oldest = chat.oldestBlockId;
    chat.loadingOlder;
    chat.reachedOldest;

    untrack(() => {
      if (oldest === null) return;
      if (chat.loadingOlder || chat.reachedOldest) return;
      if (!topSentinelObserver || !topSentinel) return;
      topSentinelObserver.unobserve(topSentinel);
      topSentinelObserver.observe(topSentinel);
    });
  });

  $effect(() => {
    if (readonly) return;
    if (!bottomSentinel) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          chat.pinnedToBottom = e.isIntersecting;
        }
      },
      // Match the old scroll-math threshold: treat "within 200px of the
      // bottom" as pinned. Positive `bottom` rootMargin extends the
      // observation root downward, so the sentinel keeps reporting
      // intersecting for 200px after it scrolls up out of strict view.
      { rootMargin: "0px 0px 200px 0px" },
    );
    obs.observe(bottomSentinel);
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
</script>

<div class="list">
  {#if !readonly}
    <div bind:this={topSentinel} class="top-sentinel" aria-hidden="true">
      {#if chat.reachedOldest && list.length > 0}
        <span class="hint dim">Beginning of history</span>
      {/if}
      <!-- The transient `loadingOlder` indicator now lives in ChatShell as a
           floating pill so it's actually visible while pagination runs;
           inline-here got missed because it was hidden in the same scroll
           zone the user just left. -->
    </div>
  {/if}
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
  {#each list as msg (msg.id)}
    {#if msg.kind === "error"}
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
    {:else if msg.role === "tool"}
      <div class="message inline">
        <ToolBlock
          toolName={msg.toolName ?? ""}
          status={(msg.status === "running" || msg.status === "done" || msg.status === "error" ? msg.status : "running") as "running" | "done" | "error"}
          input={msg.input}
          output={msg.output} />
      </div>
    {:else if msg.role === "thinking"}
      <div class="message inline">
        <ThinkingBlock
          text={msg.text}
          status={msg.status === "done" ? "done" : "running"} />
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
            {#if msg.queueId}
              {@const q = queueEntry(msg.queueId)}
              {#if q?.status === "failed"}
                <div class="footer-tag failed-row">
                  <span>Failed{q.lastError ? ` — ${q.lastError}` : ""}</span>
                  <button type="button" class="queue-action" onclick={() => retryQueued(q.id)}>Keep retrying</button>
                  <button type="button" class="queue-action" onclick={() => discardOne(q.id)}>Discard and continue</button>
                  <button type="button" class="queue-action" onclick={discardAll}>Discard all and continue</button>
                </div>
              {:else if q?.status === "retrying"}
                <div class="footer-tag queued">Retrying… ({q.attempts}/5)</div>
              {:else if q}
                <div class="footer-tag queued">Queued — waiting to send</div>
              {/if}
              <!-- No else for the missing-entry case: a bubble can keep a
                   stale queueId (e.g. a 200 response whose body lacked
                   turn_id — sendQueue.remove already ran, confirmPending
                   never did) and a pill claiming "queued" while the
                   queue is empty is worse than no pill. FRI-6. -->
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
          {:else}
            <Markdown source={msg.text} streaming={msg.status === "streaming"} />
            {#if msg.status === "aborted"}
              <div class="footer-tag">Stopped</div>
            {:else if msg.status === "stopping"}
              <div class="footer-tag stopping">Stopping…</div>
            {:else if msg.status === "error"}
              <div class="footer-tag err">Error</div>
            {:else if msg.status === "streaming"}
              <div class="footer-tag streaming">…</div>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
  {/each}
  {#if !readonly}
    <div
      bind:this={bottomSentinel}
      class="bottom-sentinel"
      aria-hidden="true"
    ></div>
  {/if}
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
  .footer-tag.streaming {
    color: var(--accent-primary);
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
    border: 1px solid var(--status-error, #d44);
    background: color-mix(in srgb, var(--status-error, #d44) 10%, transparent);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-size: 0.85rem;
  }
  .error-msg { flex: 1; }
  .retry-btn {
    background: var(--status-error, #d44);
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
</style>
