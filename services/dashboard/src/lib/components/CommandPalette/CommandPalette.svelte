<script lang="ts">
  import { Dialog } from "bits-ui";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { chat } from "$lib/stores/chat.svelte";
  import { mode, userPrefersMode, setMode } from "mode-watcher";
  import { commandPalette } from "./store.svelte";
  import {
    assembleSections,
    flattenSections,
    type Mode,
    type PaletteItem,
  } from "./items";

  let inputEl: HTMLInputElement | undefined = $state();
  let listEl: HTMLDivElement | undefined = $state();
  let activeIndex = $state(0);

  const currentPath = $derived($page.url.pathname);
  const isChat = $derived(
    currentPath === "/" || /^\/sessions\/[^/]+(\/[^/]+)?\/?$/.test(currentPath),
  );

  const userMode = $derived<Mode>(userPrefersMode.current ?? "system");

  const sections = $derived(
    assembleSections({
      agents: chat.agents,
      isChat,
      query: commandPalette.query,
      recents: commandPalette.recents,
      userMode,
      currentPath,
      onSetMode: (m) => setMode(m),
    }),
  );

  const flat = $derived(flattenSections(sections));

  $effect(() => {
    // Re-clamp the cursor when the visible list shrinks (typing narrows
    // results) so it doesn't dangle past the end.
    if (activeIndex >= flat.length) activeIndex = Math.max(0, flat.length - 1);
  });

  $effect(() => {
    // Reset cursor and refocus the input every time the palette opens.
    if (commandPalette.open) {
      commandPalette.hydrate();
      activeIndex = 0;
      queueMicrotask(() => inputEl?.focus());
    }
  });

  $effect(() => {
    // Scroll the active row into view as the cursor moves.
    if (!commandPalette.open || !listEl) return;
    const node = listEl.querySelector<HTMLElement>(
      `[data-row-index="${activeIndex}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  });

  function onOpenChange(open: boolean) {
    if (!open) commandPalette.closePalette();
    else commandPalette.openPalette();
  }

  function flatIndexOf(item: PaletteItem): number {
    return flat.findIndex((f) => f.kind === item.kind && f.id === item.id);
  }

  function activate(item: PaletteItem) {
    if (item.current) {
      commandPalette.closePalette();
      return;
    }
    commandPalette.pushRecent({ kind: item.kind, id: item.id });
    if (item.action) item.action();
    else if (item.href) void goto(item.href);
    commandPalette.closePalette();
  }

  function onInputKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length === 0) return;
      activeIndex = (activeIndex + 1) % flat.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length === 0) return;
      activeIndex = (activeIndex - 1 + flat.length) % flat.length;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = flat[activeIndex];
      if (it) activate(it);
    } else if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      const n = Number(e.key) - 1;
      if (flat[n]) activate(flat[n]);
    }
  }

  function statusDotColor(status: string | undefined): string {
    return status === "working"
      ? "var(--status-ok)"
      : status === "stalled"
        ? "var(--status-warn)"
        : status === "error"
          ? "var(--status-error)"
          : "var(--text-tertiary)";
  }

  // Mode-watcher's `mode` getter is a $state proxy; surface it for the
  // input's keyboard hint so the palette's chrome reads the resolved
  // theme even when "Follow system" is selected.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _resolvedMode = $derived(mode.current);
</script>

{#if commandPalette.open}
  <Dialog.Root open={true} {onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay class="palette-overlay" />
      <Dialog.Content class="palette-content" interactOutsideBehavior="close">
        <Dialog.Title class="sr-only">Command palette</Dialog.Title>
        <Dialog.Description class="sr-only">
          Search agents, pages, and settings. Arrow keys to navigate. Enter to select.
        </Dialog.Description>
        <div class="palette-input-row">
          <input
            bind:this={inputEl}
            bind:value={commandPalette.query}
            class="palette-input"
            type="text"
            placeholder="Search agents, pages, settings…"
            spellcheck="false"
            autocomplete="off"
            aria-autocomplete="list"
            aria-controls="palette-listbox"
            aria-activedescendant={flat[activeIndex]
              ? `palette-row-${activeIndex}`
              : undefined}
            onkeydown={onInputKeydown} />
          <span class="palette-input-chip" aria-hidden="true">⌘K</span>
        </div>

        <div
          bind:this={listEl}
          id="palette-listbox"
          role="listbox"
          class="palette-list">
          {#each sections as section (section.id)}
            <div class="palette-section">
              <div class="palette-section-head">{section.heading}</div>
              {#each section.items as item (item.kind + ":" + item.id)}
                {@const idx = flatIndexOf(item)}
                {@const Icon = item.icon}
                <button
                  type="button"
                  id={`palette-row-${idx}`}
                  data-row-index={idx}
                  role="option"
                  aria-selected={idx === activeIndex}
                  class="palette-row"
                  class:active={idx === activeIndex}
                  class:is-current={item.current}
                  onmouseenter={() => (activeIndex = idx)}
                  onclick={() => activate(item)}>
                  <span
                    class="agent-dot"
                    class:placeholder={item.kind !== "agent"}
                    class:archived={item.agentStatus === "archived"}
                    class:pulse={item.agentStatus === "working"}
                    style:background={item.kind === "agent" &&
                    item.agentStatus !== "archived"
                      ? statusDotColor(item.agentStatus)
                      : undefined}
                    aria-hidden="true"
                  ></span>
                  <span
                    class="palette-icon"
                    style:color={item.iconColor ? `var(${item.iconColor})` : undefined}
                    aria-hidden="true">
                    <Icon size={16} strokeWidth={2} />
                  </span>
                  <span class="palette-label">
                    {#if item.labelParts}
                      {#each item.labelParts as part}
                        {#if part.match}
                          <mark>{part.text}</mark>
                        {:else}
                          {part.text}
                        {/if}
                      {/each}
                    {:else}
                      {item.label}
                    {/if}
                  </span>
                  {#if item.current}
                    <span class="palette-current">current</span>
                  {/if}
                  {#if item.secondary && !item.current}
                    <span class="palette-secondary">{item.secondary}</span>
                  {/if}
                  <span
                    class="palette-chord"
                    class:invisible={idx >= 9}
                    aria-hidden="true">
                    {idx < 9 ? `⌃${idx + 1}` : "⌃9"}
                  </span>
                </button>
              {/each}
            </div>
          {/each}
          {#if sections.length === 0}
            <div class="palette-empty">No matches</div>
          {/if}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
{/if}

<style>
  :global(.palette-overlay) {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(8px) saturate(120%);
    -webkit-backdrop-filter: blur(8px) saturate(120%);
    z-index: 400;
  }

  :global(.palette-content) {
    position: fixed;
    top: 18vh;
    left: 50%;
    transform: translateX(-50%);
    z-index: 401;
    width: min(640px, calc(100vw - 2rem));
    max-height: 64vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
  }

  :global(.palette-content .sr-only) {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .palette-input-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.85rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .palette-input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 1rem;
    line-height: 1.4;
  }
  .palette-input::placeholder {
    color: var(--text-tertiary);
  }
  .palette-input-chip {
    flex-shrink: 0;
    padding: 0.15rem 0.45rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.04em;
  }

  .palette-list {
    overflow-y: auto;
    padding: 0.4rem 0;
  }

  .palette-section {
    padding: 0.15rem 0;
  }
  .palette-section + .palette-section {
    border-top: 1px solid var(--border-subtle);
    margin-top: 0.3rem;
    padding-top: 0.35rem;
  }
  .palette-section-head {
    padding: 0.25rem 1rem 0.2rem;
    font-size: 0.66rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-tertiary);
  }

  .palette-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.5rem 1rem;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-primary);
    text-align: left;
    font: inherit;
    position: relative;
    border-left: 2px solid transparent;
    transition: background var(--transition-fast);
  }
  .palette-row:hover,
  .palette-row.active {
    background: var(--bg-tertiary);
    border-left-color: var(--accent-primary);
  }
  .palette-row:focus-visible {
    outline: none;
  }

  .palette-icon {
    display: inline-flex;
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  .palette-row.active .palette-icon {
    color: var(--text-primary);
  }

  .palette-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.9rem;
  }
  .palette-label :global(mark) {
    background: transparent;
    color: var(--accent-primary);
    font-weight: 600;
  }

  .palette-secondary {
    color: var(--text-tertiary);
    font-size: 0.75rem;
    font-family: var(--font-mono);
    flex-shrink: 0;
  }

  .palette-current {
    color: var(--text-tertiary);
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--border-subtle);
    border-radius: 99px;
    flex-shrink: 0;
  }

  .palette-chord {
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    padding: 0.05rem 0.35rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    flex-shrink: 0;
    opacity: 0.65;
  }
  .palette-row.active .palette-chord {
    opacity: 1;
  }
  /* Rows past the 9th still reserve the chord-chip column so labels and
     secondaries stay vertically aligned — `visibility: hidden` keeps the
     box laid out, only the painted contents are suppressed. */
  .palette-chord.invisible {
    visibility: hidden;
  }
  .palette-row.active .palette-chord.invisible {
    visibility: hidden;
  }

  .agent-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    position: relative;
    box-sizing: border-box;
  }
  /* Non-agent rows still reserve the dot column so icons line up
     vertically with agent rows. */
  .agent-dot.placeholder {
    background: transparent;
  }
  /* Universal "this agent is archived" affordance — hollow circle.
     Matches the sidebar's archived-dot treatment so the same visual
     signal reads the same wherever an agent appears. */
  .agent-dot.archived {
    background: transparent !important;
    border: 1px solid var(--text-tertiary);
  }
  .agent-dot.pulse::before {
    content: "";
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    background: inherit;
    opacity: 0.3;
    animation: palette-pulse 2s ease-in-out infinite;
  }
  @keyframes palette-pulse {
    0%,
    100% {
      transform: scale(1);
      opacity: 0.3;
    }
    50% {
      transform: scale(1.8);
      opacity: 0;
    }
  }

  .palette-empty {
    padding: 1.5rem 1rem;
    text-align: center;
    color: var(--text-tertiary);
    font-size: 0.85rem;
  }

  @media (max-width: 640px) {
    :global(.palette-content) {
      top: 8vh;
      max-height: 80vh;
    }
    .palette-chord {
      display: none;
    }
  }
</style>
