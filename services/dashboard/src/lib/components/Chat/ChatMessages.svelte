<script lang="ts">
  import { chat, type ChatMessage } from "$lib/stores/chat.svelte";
  import Markdown from "$lib/components/Markdown/Markdown.svelte";
  import ToolBlock from "$lib/components/Chat/ToolBlock.svelte";
  import ThinkingBlock from "$lib/components/Chat/ThinkingBlock.svelte";

  let { messages }: { messages?: ChatMessage[] } = $props();
  let allMessages = $derived(messages ?? chat.messages);
  let readonly = $derived(messages !== undefined);

  // DOM windowing. When the user is bottom-pinned (scrolled to or near the
  // latest), only render the last WINDOW_SIZE messages — keeps the DOM
  // bounded for long-running chats. The moment the user scrolls up to read
  // older history we render everything, including any pages already loaded
  // via top-sentinel pagination, so they can browse freely. Read-only
  // session views always render the full passed-in array.
  const WINDOW_SIZE = 200;
  let list = $derived.by(() => {
    if (readonly) return allMessages;
    if (!chat.pinnedToBottom) return allMessages;
    if (allMessages.length <= WINDOW_SIZE) return allMessages;
    return allMessages.slice(allMessages.length - WINDOW_SIZE);
  });

  // Top-sentinel pagination. When the user scrolls up to the top of the
  // chat, the sentinel comes into view and we fetch the next 50 older
  // turns from /api/agents/:name/turns?beforeId=…. Read-only / past-session
  // mode uses its own messages array (passed in via `messages` prop) and
  // doesn't paginate — those views show a single fixed session.
  let topSentinel: HTMLDivElement | undefined = $state();
  // Bottom sentinel. An IntersectionObserver tracks whether the bottom of
  // the chat is in view (within 200px); the result drives chat.pinnedToBottom
  // which gates auto-scroll, the jump-to-latest button, and the DOM-cap
  // window slice. Replaces the previous scroll-position math in ChatShell.
  let bottomSentinel: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (readonly) return;
    if (!topSentinel) return;
    const el = topSentinel;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          if (chat.loadingOlder || chat.reachedOldest) continue;
          // Capture scroll-anchor: keep the user looking at roughly the same
          // turn after we prepend, instead of jumping to the new top.
          const scroller = el.closest(".chat-scroll") as HTMLElement | null;
          const beforeHeight = scroller?.scrollHeight ?? 0;
          const beforeTop = scroller?.scrollTop ?? 0;
          void chat.loadOlderTurns().then(() => {
            if (!scroller) return;
            queueMicrotask(() => {
              const delta = scroller.scrollHeight - beforeHeight;
              if (delta > 0) scroller.scrollTop = beforeTop + delta;
            });
          });
        }
      },
      { rootMargin: "200px 0px 0px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
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
    {#if !readonly && chat.loadingInitial}
      <div class="skeleton-list" aria-hidden="true">
        <div class="skeleton-bubble assistant"></div>
        <div class="skeleton-bubble user"></div>
        <div class="skeleton-bubble assistant"></div>
      </div>
    {:else}
      <div class="empty">
        <h2>👑 Friday</h2>
        <p>Say hi or ask for what you want done.</p>
      </div>
    {/if}
  {/if}
  {#each list as msg (msg.id)}
    {#if msg.role === "tool"}
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
    {:else}
      <div class="message {msg.role}" data-status={msg.status}>
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
              <div class="footer-tag queued">Queued — waiting to send</div>
            {/if}
          {:else}
            <Markdown source={msg.text} />
            {#if msg.status === "aborted"}
              <div class="footer-tag">Stopped</div>
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
  .footer-tag.queued {
    color: var(--text-inverse);
    opacity: 0.85;
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
