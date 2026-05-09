<script lang="ts">
  import ChatMessages from "$lib/components/Chat/ChatMessages.svelte";
  import ChatInput from "$lib/components/Chat/ChatInput.svelte";
  import Sidebar from "$lib/components/Sidebar/Sidebar.svelte";
  import {
    chat,
    parseTurns,
    type ChatMessage,
    type TurnRow,
  } from "$lib/stores/chat.svelte";
  import { onMount, untrack } from "svelte";

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
  let pinnedToBottom = $state(true);

  // Read-only mode keeps its own messages list so SSE doesn't mutate it.
  let pastMessages = $state<ChatMessage[]>([]);

  function isNearBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 200;
  }
  function onScroll() {
    if (!scrollEl) return;
    pinnedToBottom = isNearBottom(scrollEl);
  }
  function jumpToBottom() {
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
    pinnedToBottom = true;
  }

  // Active mode: keep focusedAgent in sync with the current route, reload
  // turns whenever the agent changes.
  $effect(() => {
    if (readonly) return;
    const a = agent;
    untrack(() => {
      if (chat.focusedAgent !== a) chat.focusedAgent = a;
      void chat.loadAgentTurns(a);
    });
  });

  // Read-only mode: load past session turns once.
  $effect(() => {
    if (!readonly || !sessionId) return;
    const sid = sessionId;
    void (async () => {
      try {
        const r = await fetch(`/api/sessions/${sid}/turns?limit=500`);
        if (!r.ok) return;
        const turns = (await r.json()) as TurnRow[];
        pastMessages = parseTurns(turns, agent);
      } catch {
        // ignore
      }
    })();
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
      scrollEl?.style.setProperty("--chat-input-h", `${h}px`);
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
    if (readonly && scrollEl) {
      scrollEl.style.setProperty("--chat-input-h", "0px");
    }
  });
</script>

<aside class="chat-sidebar-floating">
  <Sidebar />
</aside>

<section class="chat-scroll" bind:this={scrollEl} onscroll={onScroll}>
  {#if readonly}
    <div class="readonly-banner">
      Past session — read only
    </div>
  {/if}
  <ChatMessages messages={readonly ? pastMessages : undefined} />
</section>

{#if !readonly && !pinnedToBottom}
  <button class="jump-to-bottom" type="button" onclick={jumpToBottom} aria-label="Scroll to latest">
    ↓ Latest
  </button>
{/if}

{#if !readonly}
  <div class="chat-input-floating" bind:this={inputEl}>
    <ChatInput />
  </div>
{/if}

<style>
  .chat-scroll,
  .chat-sidebar-floating,
  .chat-input-floating {
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

  .jump-to-bottom {
    position: fixed;
    bottom: calc(var(--chat-input-h, 6rem) + 2.5rem);
    left: 50%;
    transform: translateX(-50%);
    padding: 0.4rem 0.85rem;
    border-radius: var(--radius-md);
    background: var(--accent-primary);
    color: var(--text-inverse);
    border: 1px solid var(--accent-primary);
    box-shadow: var(--shadow-lg);
    font-size: 0.8rem;
    cursor: pointer;
    z-index: 95;
  }
  .jump-to-bottom:hover {
    filter: brightness(1.05);
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
  }

  @media (max-width: 640px) {
    .chat-input-floating { bottom: 0.5rem; }
  }
</style>
