<script lang="ts">
  import { chat } from "$lib/stores/chat.svelte";
  import { goto } from "$app/navigation";
  import { portal } from "$lib/actions/portal";
  import { onMount, tick } from "svelte";

  interface CommandsResponse {
    system: Array<{ name: string; description: string; destructive?: boolean }>;
    skills: Array<{ name: string; description: string; source: string }>;
  }

  let text = $state("");
  let textarea: HTMLTextAreaElement | undefined = $state();
  let busy = $derived(chat.inflightTurnId !== null);
  // Touch keyboards (phones, tablets without a hardware keyboard) treat
  // Enter as "newline" — sending happens via the on-screen send button. We
  // detect that via the `(pointer: coarse)` media query. The flag is kept
  // reactive so plugging in a Bluetooth keyboard switches behavior.
  let isCoarsePointer = $state(false);

  let commands = $state<CommandsResponse>({ system: [], skills: [] });
  let confirmingCommand = $state<{
    name: string;
    args: string;
    description: string;
  } | null>(null);

  onMount(() => {
    void fetch("/api/commands")
      .then((r) => r.json())
      .then((c: CommandsResponse) => (commands = c))
      .catch(() => undefined);

    const mq = window.matchMedia("(pointer: coarse)");
    isCoarsePointer = mq.matches;
    const onChange = (e: MediaQueryListEvent) => (isCoarsePointer = e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  });

  let showAutocomplete = $derived(text.startsWith("/") && !text.includes("\n"));
  let slashPart = $derived.by(() => {
    if (!showAutocomplete) return "";
    const sp = text.indexOf(" ");
    return sp === -1 ? text.slice(1) : text.slice(1, sp);
  });
  let argsPart = $derived.by(() => {
    const sp = text.indexOf(" ");
    return sp === -1 ? "" : text.slice(sp + 1);
  });
  let suggestions = $derived.by(() => {
    if (!showAutocomplete) return [];
    const q = slashPart.toLowerCase();
    const sys = commands.system
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .map((c) => ({ ...c, kind: "system" as const }));
    const sk = commands.skills
      .filter((s) => s.name.toLowerCase().startsWith(q))
      .map((s) => ({ ...s, kind: "skill" as const }));
    return [...sys, ...sk];
  });

  let selectedIdx = $state(0);
  $effect(() => {
    suggestions.length;
    selectedIdx = 0;
  });

  async function submit() {
    const t = text.trim();
    if (!t || busy) return;

    if (t.startsWith("/")) {
      const space = t.indexOf(" ");
      const name = (space === -1 ? t.slice(1) : t.slice(1, space)).toLowerCase();
      const args = space === -1 ? "" : t.slice(space + 1);
      const sysCmd = commands.system.find((c) => c.name === name);
      if (sysCmd) {
        if (sysCmd.destructive) {
          confirmingCommand = { name: sysCmd.name, args, description: sysCmd.description };
          return;
        }
        text = "";
        await dispatchSystem(name, args);
        return;
      }
    }

    chat.addUser(t);
    text = "";
    // Wait for the bound textarea value to actually clear before measuring.
    // Without this, scrollHeight still reflects the multi-line draft and
    // autoresize sizes the box to the *old* content.
    await tick();
    autoresize();
    try {
      const r = await fetch("/api/chat/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t, agent: chat.focusedAgent }),
      });
      if (!r.ok) {
        const err = await r.text();
        chat.messages.push({
          id: `err_${Date.now()}`,
          role: "assistant",
          text: `Error: ${err}`,
          status: "error",
          ts: Date.now(),
        });
        return;
      }
      const { turn_id } = (await r.json()) as { turn_id: string };
      // Don't pre-mount the assistant bubble. The chat store creates it
      // lazily when the first text_delta arrives, so any thinking or tool
      // blocks that fire earlier render in their natural order above it.
      chat.inflightTurnId = turn_id;
    } catch (err: unknown) {
      chat.messages.push({
        id: `err_${Date.now()}`,
        role: "assistant",
        text: `Network error: ${err instanceof Error ? err.message : String(err)}`,
        status: "error",
        ts: Date.now(),
      });
    }
  }

  async function dispatchSystem(name: string, args: string): Promise<void> {
    try {
      const r = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: name, args }),
      });
      const data = (await r.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
        agent?: string;
      };
      // /scratch returns the freshly-generated agent name; jump straight to
      // its chat view so the user can keep typing without a sidebar click.
      if (r.ok && name === "scratch" && data.agent) {
        await goto(`/sessions/${data.agent}`);
        return;
      }
      const msg = data.message ?? data.error ?? JSON.stringify(data);
      chat.messages.push({
        id: `sys_${Date.now()}`,
        role: "assistant",
        text: `**/${name}** — ${msg}`,
        status: r.ok ? "complete" : "error",
        ts: Date.now(),
      });
    } catch (err: unknown) {
      chat.messages.push({
        id: `sys_${Date.now()}`,
        role: "assistant",
        text: `**/${name}** — error: ${err instanceof Error ? err.message : String(err)}`,
        status: "error",
        ts: Date.now(),
      });
    }
  }

  async function confirmDestructive(): Promise<void> {
    if (!confirmingCommand || !confirmSummary?.valid) return;
    const name = confirmingCommand.name;
    const args = confirmSummary.resolvedArgs;
    confirmingCommand = null;
    text = "";
    await tick();
    autoresize();
    await dispatchSystem(name, args);
  }

  async function stop() {
    if (!chat.inflightTurnId) return;
    await fetch(`/api/chat/turn/${chat.inflightTurnId}/abort`, { method: "POST" });
  }

  function onKeydown(e: KeyboardEvent) {
    if (showAutocomplete && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        selectedIdx = (selectedIdx + 1) % suggestions.length;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        selectedIdx = (selectedIdx - 1 + suggestions.length) % suggestions.length;
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        applySuggestion(selectedIdx);
        return;
      }
    }
    // On touch devices Enter inserts a newline; the send button is the only
    // way to submit. Hardware-keyboard users (desktop + tablets with a
    // keyboard attached) keep Enter-to-send / Shift+Enter-newline.
    if (e.key === "Enter" && !e.shiftKey && !isCoarsePointer) {
      e.preventDefault();
      void submit();
    }
  }

  function applySuggestion(idx: number) {
    const s = suggestions[idx];
    if (!s) return;
    text = `/${s.name} ${argsPart}`.replace(/\s+$/, " ");
    autoresize();
    textarea?.focus();
  }

  /** Mobile keyboard preservation: prevent input from blurring on tap. */
  function onSuggestionPointerdown(e: PointerEvent, idx: number) {
    e.preventDefault();
    applySuggestion(idx);
  }

  interface ConfirmSummary {
    /** When false, the modal shows an explanation but no destructive button;
     * Cancel becomes "Okay". */
    valid: boolean;
    title: string;
    details: string;
    confirmLabel: string;
    /** Args that should actually be sent to the daemon if the user confirms.
     * Populated from typed args, with sensible fallbacks (e.g. focused agent
     * for /kill with no target). */
    resolvedArgs: string;
  }

  function summarizeDestructive(
    name: string,
    args: string,
    focused: string,
  ): ConfirmSummary {
    const provided = args.trim();
    switch (name) {
      case "kill": {
        const target = provided || focused;
        const found = chat.agents.find((a) => a.name === target);
        if (!target) {
          return {
            valid: false,
            title: "No agent to kill",
            details:
              "There's no agent currently focused. Type `/kill <agent>` with a name.",
            confirmLabel: "",
            resolvedArgs: "",
          };
        }
        if (!found) {
          return {
            valid: false,
            title: `Agent ${target} not found`,
            details: provided
              ? `No registered agent matches \`${target}\`.`
              : `The focused agent \`${target}\` isn't in the registry anymore.`,
            confirmLabel: "",
            resolvedArgs: target,
          };
        }
        return {
          valid: true,
          title: `Kill agent ${target}?`,
          details:
            "The agent will be stopped and marked killed. Its persisted turn history remains.",
          confirmLabel: "Kill the agent",
          resolvedArgs: target,
        };
      }
      case "reset-context": {
        const target = provided || focused;
        const found = chat.agents.find((a) => a.name === target);
        if (!target) {
          return {
            valid: false,
            title: "No agent to reset",
            details:
              "There's no agent currently focused. Type `/reset-context <agent>` with a name.",
            confirmLabel: "",
            resolvedArgs: "",
          };
        }
        if (!found) {
          return {
            valid: false,
            title: `Agent ${target} not found`,
            details: `No registered agent matches \`${target}\`.`,
            confirmLabel: "",
            resolvedArgs: target,
          };
        }
        return {
          valid: true,
          title: `Reset context for ${target}?`,
          details:
            "The agent's current session is cleared so the next turn starts fresh. Memory entries persist.",
          confirmLabel: "Reset the agent",
          resolvedArgs: target,
        };
      }
      case "restart":
        return {
          valid: true,
          title: "Restart the Friday daemon?",
          details:
            "The daemon exits and relies on its supervisor (e.g. tmux) to bring it back. Any in-flight turns are aborted.",
          confirmLabel: "Restart the daemon",
          resolvedArgs: "",
        };
      default:
        return {
          valid: true,
          title: `Run /${name}?`,
          details: provided ? `Args: ${provided}` : "",
          confirmLabel: `Run /${name}`,
          resolvedArgs: provided,
        };
    }
  }

  let confirmSummary = $derived(
    confirmingCommand
      ? summarizeDestructive(
          confirmingCommand.name,
          confirmingCommand.args,
          chat.focusedAgent,
        )
      : null,
  );

  function autoresize() {
    if (!textarea) return;
    const cs = getComputedStyle(textarea);
    const lineH = parseFloat(cs.lineHeight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    if (!Number.isFinite(lineH) || lineH <= 0) {
      textarea.style.height = "auto";
      return;
    }
    // Cap at roughly half the viewport, rounded down to a whole line count.
    const maxLines = Math.max(1, Math.floor((window.innerHeight * 0.5 - padY - borderY) / lineH));
    textarea.style.height = "auto";
    const contentH = textarea.scrollHeight - padY;
    const rawLines = contentH / lineH;
    const lines = Math.min(Math.max(1, Math.ceil(rawLines - 0.05)), maxLines);
    textarea.style.height = lines * lineH + padY + borderY + "px";
  }
</script>

<div class="input-wrap">
  {#if showAutocomplete && suggestions.length > 0}
    <div class="autocomplete" role="listbox">
      {#each suggestions as s, i}
        <div
          class="row"
          class:selected={i === selectedIdx}
          role="option"
          tabindex="-1"
          aria-selected={i === selectedIdx}
          onpointerdown={(e) => onSuggestionPointerdown(e, i)}>
          <span class="name">/{s.name}</span>
          <span class="badge {s.kind}">{s.kind}</span>
          <span class="desc">{s.description}</span>
        </div>
      {/each}
    </div>
  {/if}

  <form class="input" onsubmit={(e) => { e.preventDefault(); void submit(); }}>
    <textarea
      bind:this={textarea}
      bind:value={text}
      onkeydown={onKeydown}
      oninput={autoresize}
      placeholder="Message Friday… or /command"
      rows="1"
      autocomplete="off"
      autocapitalize="off"
    ></textarea>
    {#if busy}
      <button type="button" class="stop" onclick={stop}>Stop</button>
    {:else}
      <button type="submit" class="send" disabled={!text.trim()}>Send</button>
    {/if}
  </form>
</div>

{#if confirmingCommand && confirmSummary}
  <div class="modal-backdrop" use:portal>
    <div class="modal">
      <h3>{confirmSummary.title}</h3>
      {#if confirmSummary.details}
        <p>{confirmSummary.details}</p>
      {/if}
      {#if confirmSummary.valid}
        <p class="warn">This action is destructive.</p>
      {/if}
      <div class="actions">
        <button type="button" onclick={() => (confirmingCommand = null)}>
          {confirmSummary.valid ? "Cancel" : "Okay"}
        </button>
        {#if confirmSummary.valid}
          <button type="button" class="confirm" onclick={confirmDestructive}>
            {confirmSummary.confirmLabel}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .input-wrap {
    position: relative;
    width: 100%;
  }
  .input {
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
    padding: 0.75rem 1rem;
    background: transparent;
  }
  textarea {
    flex: 1;
    resize: none;
    padding: 0.55rem 0.85rem;
    line-height: 1.4;
    overflow-y: auto;
    max-height: 50vh;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-primary);
    background: var(--bg-input);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 0.9rem;
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }
  textarea:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }
  .send,
  .stop {
    /* Match textarea's 1-line height: same line-height + vertical padding +
       border thickness so the button equals one row of the textarea. */
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: 0.55rem 1.1rem;
    font-weight: 600;
    font-size: 0.9rem;
    line-height: 1.4;
    min-width: 80px;
    flex-shrink: 0;
    cursor: pointer;
    transition: background var(--transition-fast), opacity var(--transition-fast);
  }
  .send {
    background: var(--accent-primary);
    color: var(--text-inverse);
  }
  .send:hover { background: var(--accent-secondary); }
  .send:disabled { opacity: 0.5; cursor: not-allowed; }
  .stop {
    background: var(--status-error);
    color: var(--text-inverse);
  }
  .autocomplete {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    left: 0;
    right: 0;
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    max-height: 240px;
    overflow-y: auto;
    z-index: 10;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 1rem;
    cursor: pointer;
    min-height: 44px;
    transition: background var(--transition-fast);
  }
  .row.selected,
  .row:hover {
    background: var(--bg-card-hover);
  }
  .name {
    color: var(--accent-primary);
    font-family: var(--font-mono);
    font-size: 0.85rem;
  }
  .badge {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.15rem 0.4rem;
    border-radius: 99px;
    background: var(--bg-tertiary);
    color: var(--text-tertiary);
    font-weight: 600;
  }
  .badge.system {
    background: var(--accent-glow);
    color: var(--accent-primary);
  }
  .desc {
    color: var(--text-secondary);
    font-size: 0.8rem;
    flex: 1;
  }
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    padding: 1rem;
  }
  .modal {
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    padding: 1.5rem;
    max-width: 480px;
    width: 100%;
    box-shadow: var(--shadow-lg);
    color: var(--text-primary);
  }
  .modal h3 { margin: 0 0 0.5rem 0; color: var(--text-primary); }
  .modal p { color: var(--text-secondary); margin: 0.5rem 0; }
  .modal .warn { color: var(--status-warn); }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1.25rem;
  }
  .actions button {
    background: none;
    border: 1px solid var(--border-primary);
    color: var(--text-secondary);
    padding: 0.5rem 1rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-weight: 500;
    transition: all var(--transition-fast);
  }
  .actions button:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }
  .actions .confirm {
    background: var(--status-error);
    color: var(--text-inverse);
    border-color: var(--status-error);
  }
  .actions .confirm:hover {
    opacity: 0.9;
    background: var(--status-error);
  }
  @media (max-width: 768px) {
    /* iOS Safari zooms the page when you focus an input whose font-size is
       below 16px. Bump the textarea to 16px on mobile to suppress that.
       Buttons match so their computed height stays one textarea row. */
    textarea { font-size: 16px; }
    .send,
    .stop { font-size: 16px; }
    .modal {
      max-width: 100%;
      height: 100vh;
      border-radius: 0;
      border: none;
      display: flex;
      flex-direction: column;
    }
    .actions { margin-top: auto; }
  }
</style>
