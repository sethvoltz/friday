<script lang="ts">
  import { chat, type ChatMessage } from "$lib/stores/chat.svelte";
  import Markdown from "$lib/components/Markdown/Markdown.svelte";
  import ToolBlock from "$lib/components/Chat/ToolBlock.svelte";
  import ThinkingBlock from "$lib/components/Chat/ThinkingBlock.svelte";

  let { messages }: { messages?: ChatMessage[] } = $props();
  let list = $derived(messages ?? chat.messages);
</script>

<div class="list">
  {#if list.length === 0}
    <div class="empty">
      <h2>👑 Friday</h2>
      <p>Say hi or ask for what you want done.</p>
    </div>
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
</style>
