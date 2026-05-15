<script lang="ts">
  import { chat } from "$lib/stores/chat.svelte";
  import { goto } from "$app/navigation";
  import { portal } from "$lib/actions/portal";
  import { KEYS, loadString, removeKey, saveString } from "$lib/stores/persistent";
  import { sendQueue } from "$lib/stores/send-queue.svelte";
  import { onDestroy, onMount, tick } from "svelte";
  import { Paperclip, Send, CircleStop } from "lucide-svelte";

  interface CommandsResponse {
    system: Array<{ name: string; description: string; destructive?: boolean }>;
    skills: Array<{ name: string; description: string; source: string }>;
  }

  let text = $state("");
  let textarea: HTMLTextAreaElement | undefined = $state();
  let busy = $derived(chat.inflightTurnId !== null);
  // True between the user clicking Stop and the daemon emitting turn_done
  // for the stopping turn. Drives the Stop button's disabled/dimmed look
  // so a second click doesn't fire a redundant abort POST.
  let isStopping = $derived.by(() => {
    const id = chat.inflightTurnId;
    if (!id) return false;
    const m = chat.messages.find(
      (x) => x.role === "assistant" && (x.id === id || x.turnId === id),
    );
    return m?.status === "stopping";
  });
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

  // Slack/Messages parity: claim keystrokes for the composer when nothing
  // else has explicit focus. `document.activeElement` is the source of truth.
  $effect(() => {
    function onGlobalKeydown(e: KeyboardEvent) {
      if (!textarea) return;
      if (document.activeElement === textarea) return;
      const active = document.activeElement;
      const noExplicitFocus =
        !active || active === document.body || active === document.documentElement;
      if (!noExplicitFocus) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key.length !== 1) return;

      e.preventDefault();
      textarea.focus();
      text = (text ?? "") + e.key;
      void tick().then(() => {
        if (!textarea) return;
        const end = text.length;
        textarea.setSelectionRange(end, end);
        autoresize();
      });
    }
    window.addEventListener("keydown", onGlobalKeydown);
    return () => window.removeEventListener("keydown", onGlobalKeydown);
  });

  // Per-agent draft persistence. We key by `chat.focusedAgent` so switching
  // agents preserves each agent's unsent draft independently. Restore
  // happens whenever the focused agent changes (component is reused across
  // routes via SvelteKit's preserve-state behavior); save on every
  // keystroke.
  //
  // Subtlety: when `chat.focusedAgent` flips, naively splitting restore
  // and save across two effects can race — the save effect can observe
  // the *old* text with the *new* agent and contaminate the new agent's
  // draft key. Track the agent we last *saved* under so we only persist
  // when the captured agent matches the current one, and treat the very
  // first run after a switch as a restore-only step regardless of what
  // `text` happens to hold.
  let lastSavedAgent = $state<string | null>(null);
  $effect(() => {
    const a = chat.focusedAgent;
    if (a !== lastSavedAgent) {
      // First observation of this agent: pull its persisted draft into
      // `text`. Don't write anything — `text` may still hold the previous
      // agent's content for a single tick.
      const stored = loadString(KEYS.draft(a));
      text = stored ?? "";
      lastSavedAgent = a;
      void tick().then(autoresize);
      return;
    }
    // Steady state: persist the current text under the current agent.
    if (text) saveString(KEYS.draft(a), text);
    else removeKey(KEYS.draft(a));
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
  /** Purely client-side slash commands — intercepted in ChatInput before
   *  the system-command lookup. Surfaced in autocomplete alongside daemon
   *  system commands. FIX_FORWARD 6.1. */
  const CLIENT_COMMANDS: Array<{
    name: string;
    description: string;
  }> = [
    {
      name: "jump",
      description:
        "Search this chat. /jump <term> for FTS match, /jump <date> for a time window (today, yesterday, '2 hours ago', ISO date).",
    },
  ];

  let suggestions = $derived.by(() => {
    if (!showAutocomplete) return [];
    const q = slashPart.toLowerCase();
    const sys = commands.system
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .map((c) => ({ ...c, kind: "system" as const }));
    const client = CLIENT_COMMANDS.filter((c) =>
      c.name.toLowerCase().startsWith(q),
    ).map((c) => ({ ...c, kind: "system" as const }));
    const sk = commands.skills
      .filter((s) => s.name.toLowerCase().startsWith(q))
      .map((s) => ({ ...s, kind: "skill" as const }));
    return [...client, ...sys, ...sk];
  });

  let selectedIdx = $state(0);
  /** FIX_FORWARD 6.2: Slack-style menu nav. `false` until the user
   *  arrow-keys into the menu — then the textarea hides its caret and
   *  the highlighted item paints actively. Reset to false on typing /
   *  Esc / apply / menu close. */
  let inMenu = $state(false);
  $effect(() => {
    suggestions.length;
    selectedIdx = 0;
    if (suggestions.length === 0) inMenu = false;
  });
  // Hand focus back to the input the moment the menu closes (no
  // suggestions, or autocomplete trigger gone).
  $effect(() => {
    if (!showAutocomplete) inMenu = false;
  });

  interface PendingAttachment {
    /** Local key for keyed-each rendering and removal. */
    key: string;
    filename: string;
    mime: string;
    /** Local preview URL for image thumbnails. Revoked on remove. */
    previewUrl?: string;
    /** "uploading" until the daemon returns the sha; "done" once we have it;
     *  "error" if upload failed (chip stays so the user can dismiss). */
    status: "uploading" | "done" | "error";
    sha256?: string;
    error?: string;
  }
  let pendingAttachments = $state<PendingAttachment[]>([]);
  let fileInput: HTMLInputElement | undefined = $state();
  let dragDepth = $state(0);
  let isDragging = $derived(dragDepth > 0);

  async function uploadFile(file: File): Promise<void> {
    const key = `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const previewUrl = file.type.startsWith("image/")
      ? URL.createObjectURL(file)
      : undefined;
    const entry: PendingAttachment = {
      key,
      filename: file.name || "upload",
      mime: file.type || "application/octet-stream",
      previewUrl,
      status: "uploading",
    };
    pendingAttachments.push(entry);
    try {
      const r = await fetch("/api/uploads", {
        method: "POST",
        headers: {
          "content-type": entry.mime,
          "x-filename": entry.filename,
        },
        body: file,
      });
      const found = pendingAttachments.find((a) => a.key === key);
      if (!found) return; // user removed before response
      if (!r.ok) {
        const err = await r.text().catch(() => "upload failed");
        found.status = "error";
        found.error = err.slice(0, 200);
        // Free the blob URL — an error chip never needs the preview again,
        // and holding it alive is just a memory leak waiting on a manual
        // remove.
        if (found.previewUrl) {
          URL.revokeObjectURL(found.previewUrl);
          found.previewUrl = undefined;
        }
        return;
      }
      const data = (await r.json()) as {
        sha256: string;
        filename: string;
        mime: string;
      };
      found.status = "done";
      found.sha256 = data.sha256;
      // The daemon may have rewritten filename/mime (e.g. HEIC → PNG); reflect
      // that back so the chip and the eventual turn body match what's stored.
      found.filename = data.filename;
      found.mime = data.mime;
    } catch (err) {
      const found = pendingAttachments.find((a) => a.key === key);
      if (!found) return;
      found.status = "error";
      found.error = err instanceof Error ? err.message : String(err);
      if (found.previewUrl) {
        URL.revokeObjectURL(found.previewUrl);
        found.previewUrl = undefined;
      }
    }
  }

  /** Revoke every pending attachment's blob URL and clear the array.
   *  Used on unmount and on agent switch — pending attachments are an
   *  ephemeral compose-time concept; unlike drafts, they do not survive
   *  navigation. */
  function clearPendingAttachments(): void {
    for (const a of pendingAttachments) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    pendingAttachments = [];
  }

  // Per-agent: pending attachments are scoped to the compose box for the
  // currently focused agent. Switching agents clears them and revokes the
  // associated blob URLs so we don't accumulate.
  let lastAttachmentAgent = $state<string | null>(null);
  $effect(() => {
    const a = chat.focusedAgent;
    if (lastAttachmentAgent === null) {
      lastAttachmentAgent = a;
      return;
    }
    if (a !== lastAttachmentAgent) {
      clearPendingAttachments();
      lastAttachmentAgent = a;
    }
  });

  onDestroy(() => {
    clearPendingAttachments();
  });

  function addFiles(files: FileList | File[] | null | undefined): void {
    if (!files) return;
    for (const f of Array.from(files)) {
      void uploadFile(f);
    }
  }

  function removeAttachment(key: string): void {
    const idx = pendingAttachments.findIndex((a) => a.key === key);
    if (idx < 0) return;
    const a = pendingAttachments[idx];
    if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    pendingAttachments.splice(idx, 1);
  }

  function onFilePick(e: Event): void {
    const input = e.target as HTMLInputElement;
    addFiles(input.files);
    // Reset so picking the same file twice still fires `change`.
    input.value = "";
  }

  function onPaste(e: ClipboardEvent): void {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  }

  function onDragEnter(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    dragDepth += 1;
  }
  function onDragOver(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
  }
  function onDragLeave(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes("Files")) return;
    dragDepth = Math.max(0, dragDepth - 1);
  }
  function onDrop(e: DragEvent): void {
    if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    dragDepth = 0;
    addFiles(e.dataTransfer.files);
  }

  async function submit() {
    const t = text.trim();
    // Allow attachment-only sends (text empty but at least one ready
    // attachment) once we have anything ready.
    const ready = pendingAttachments.filter((a) => a.status === "done" && a.sha256);
    if ((!t && ready.length === 0) || busy) return;
    // Block while any attachment is still uploading; otherwise the message
    // would land without the file the user clearly meant to include.
    if (pendingAttachments.some((a) => a.status === "uploading")) return;

    if (t.startsWith("/")) {
      const space = t.indexOf(" ");
      const name = (space === -1 ? t.slice(1) : t.slice(1, space)).toLowerCase();
      const args = space === -1 ? "" : t.slice(space + 1);
      // FIX_FORWARD 6.1: /jump is a purely client-side command — it
      // searches the current agent's blocks and re-paints the chat to
      // the matched window. Intercepted before the system-command lookup
      // so the daemon never sees it.
      if (name === "jump") {
        text = "";
        await chat.jumpTo(chat.focusedAgent, args);
        return;
      }
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

    // Optimistic: enqueue first, render the user bubble with a "queued" pill,
    // then attempt to flush. If the network is down or the daemon is
    // unreachable, the bubble stays "queued" until a reconnect drains the
    // queue (see +layout.svelte's flush effect).
    const attachments = ready.map((a) => ({
      sha256: a.sha256!,
      filename: a.filename,
      mime: a.mime,
    }));
    const queueItem = sendQueue.enqueue({
      agent: chat.focusedAgent,
      text: t,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    chat.addUser(t, {
      queueId: queueItem.id,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    // Release object URLs and clear the chip row.
    for (const a of pendingAttachments) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    pendingAttachments = [];
    text = "";
    // Wait for the bound textarea value to actually clear before measuring.
    // Without this, scrollHeight still reflects the multi-line draft and
    // autoresize sizes the box to the *old* content.
    await tick();
    autoresize();
    const result = await sendQueue.flush();
    for (const s of result.sent) {
      // FIX_FORWARD 2.6: re-key the pending bubble to its canonical
      // turn-derived id so the daemon's `block_complete` for the user-role
      // block overwrites this exact row instead of creating a duplicate.
      chat.confirmPending(s.queueId, s.turnId);
      // Set the inflight turn for the most recently-sent message so the UI
      // shows the Stop button. Multi-message flushes only need the last one
      // tracked — earlier messages have already produced their own turns.
      chat.inflightTurnId = s.turnId;
    }
    for (const qid of result.failed) chat.markPendingFailed(qid);
    for (const qid of result.retrying) chat.markPendingRetrying(qid);
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
    const id = chat.inflightTurnId;
    if (!id) return;
    // Mark the bubble as stopping immediately so the UI flips out of
    // streaming-grow mode and the Stop button dims. The daemon's eventual
    // turn_done will overwrite stopping → its terminal status (typically
    // 'aborted'). Fire-and-forget the POST: the abort endpoint returns
    // synchronously but the actual SDK unwind happens asynchronously, so
    // there's nothing useful to await here.
    chat.requestStop(id);
    void fetch(`/api/chat/turn/${id}/abort`, { method: "POST" }).catch(() => {
      /* network errors are tolerable — the next turn_done will reconcile.
         If it never lands, the user can refresh; we don't want a thrown
         promise spamming the console. */
    });
  }

  function onKeydown(e: KeyboardEvent) {
    if (showAutocomplete && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!inMenu) {
          // FIX_FORWARD 6.2: first arrow press transfers nav into the
          // menu. Keep the current selectedIdx so the user lands on the
          // visible first item.
          inMenu = true;
        } else {
          selectedIdx = (selectedIdx + 1) % suggestions.length;
        }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!inMenu) {
          inMenu = true;
          selectedIdx = suggestions.length - 1;
        } else {
          selectedIdx =
            (selectedIdx - 1 + suggestions.length) % suggestions.length;
        }
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && inMenu)) {
        // Tab always applies; Enter only when the user actively navigated
        // into the menu, so plain Enter without arrowing still submits.
        e.preventDefault();
        applySuggestion(selectedIdx);
        inMenu = false;
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        inMenu = false;
        // Close menu without consuming the input — same behavior Slack
        // uses, lets the user keep typing the literal `/foo` text.
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

  // FIX_FORWARD 6.2: any keystroke that mutates input text yanks nav back
  // out of the menu (typing should keep updating the autocomplete filter
  // rather than fighting it). Hooked on `input` so it fires after the
  // bound `text` has updated.
  function onInput() {
    if (inMenu) inMenu = false;
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
     * for /archive with no target). */
    resolvedArgs: string;
  }

  function summarizeDestructive(
    name: string,
    args: string,
    focused: string,
  ): ConfirmSummary {
    const provided = args.trim();
    switch (name) {
      case "archive": {
        const target = provided || focused;
        const found = chat.agents.find((a) => a.name === target);
        if (!target) {
          return {
            valid: false,
            title: "No agent to archive",
            details:
              "There's no agent currently focused. Type `/archive <agent>` with a name.",
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
          title: `Archive agent ${target}?`,
          details:
            "The agent stops receiving work and is marked archived. For builders, the worktree is removed and the friday/<name> branch is force-deleted. Chat history is preserved.",
          confirmLabel: "Archive the agent",
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

<div
  class="input-wrap"
  class:dragging={isDragging}
  class:busy
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  role="presentation">
  <!--
    Aurora: nested so the blur owns the parent and the gradient + crop
    live on a child. Filter on the parent applies AFTER the child's mask
    paints, so the inner crop edge gets blurred soft (the outer edge of
    the gradient has no mask, so the outside stays as the wide soft
    glow). Both layers are always in the DOM; opacity fades 0 ↔ 1 when
    .busy toggles. Pointer-events: none so input clicks pass through.
  -->
  <div class="aurora" aria-hidden="true">
    <div class="aurora-mask">
      <div class="aurora-shape"></div>
    </div>
  </div>
  {#if pendingAttachments.length > 0}
    <div class="chips" aria-label="Attachments">
      {#each pendingAttachments as a (a.key)}
        <div class="chip" class:err={a.status === "error"} title={a.error ?? a.filename}>
          {#if a.previewUrl && a.mime.startsWith("image/")}
            <img class="chip-thumb" src={a.previewUrl} alt={a.filename} />
          {:else}
            <span class="chip-icon">📎</span>
          {/if}
          <span class="chip-name">{a.filename}</span>
          {#if a.status === "uploading"}
            <span class="chip-status" aria-label="Uploading">⏳</span>
          {:else if a.status === "error"}
            <span class="chip-status" aria-label="Upload failed">⚠</span>
          {/if}
          <button
            type="button"
            class="chip-remove"
            onclick={() => removeAttachment(a.key)}
            aria-label={`Remove ${a.filename}`}>×</button>
        </div>
      {/each}
    </div>
  {/if}
  {#if isDragging}
    <div class="drop-overlay" aria-hidden="true">Drop to attach</div>
  {/if}
  {#if showAutocomplete && suggestions.length > 0}
    <div class="autocomplete" role="listbox" class:in-menu={inMenu}>
      {#each suggestions as s, i}
        <div
          class="row"
          class:selected={i === selectedIdx}
          class:active={inMenu && i === selectedIdx}
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
    <input
      bind:this={fileInput}
      type="file"
      accept="image/*,application/pdf"
      multiple
      class="hidden-file"
      onchange={onFilePick} />
    <button
      type="button"
      class="icon-btn attach"
      onclick={() => fileInput?.click()}
      aria-label="Attach file"
      title="Attach file">
      <Paperclip size={18} aria-hidden="true" />
    </button>
    <textarea
      bind:this={textarea}
      bind:value={text}
      class:nav-in-menu={inMenu}
      onkeydown={onKeydown}
      oninput={() => { onInput(); autoresize(); }}
      onpaste={onPaste}
      placeholder="Message Friday… or /command"
      rows="1"
      autocomplete="off"
      autocapitalize="sentences"
    ></textarea>
    {#if busy}
      <button
        type="button"
        class="icon-btn stop"
        class:stopping={isStopping}
        onclick={stop}
        disabled={isStopping}
        aria-label={isStopping ? "Stopping" : "Stop"}
        title={isStopping ? "Stopping…" : "Stop"}>
        <CircleStop size={18} aria-hidden="true" />
      </button>
    {:else}
      <button
        type="submit"
        class="icon-btn send"
        aria-label="Send"
        title="Send"
        disabled={(!text.trim() && pendingAttachments.filter((a) => a.status === "done").length === 0) || pendingAttachments.some((a) => a.status === "uploading")}>
        <Send size={18} aria-hidden="true" />
      </button>
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
    /* Background lives on ::before so that the same element can carry
       backdrop-filter — needed to blur the aurora that paints behind
       the input bar AND the chat content scrolling below it (mirroring
       the header's translucent treatment). The wrap itself stays
       transparent so its border + focus glow remain crisp. */
    background: transparent;
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }
  .input-wrap::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--header-float-bg);
    backdrop-filter: blur(20px) saturate(160%);
    -webkit-backdrop-filter: blur(20px) saturate(160%);
    /* Sits between the aurora (z-index: 0) and the form/chips (z-index:
       2) so its backdrop-filter samples the aurora and the chat content
       behind, but never the textarea text we put on top. */
    z-index: 1;
    pointer-events: none;
  }
  /* Single bordered box — focus on any child (textarea, attach, send/stop)
     lights the whole wrap. Same accent glow the textarea used to wear. */
  .input-wrap:focus-within {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }
  .input-wrap.dragging {
    outline: 2px dashed var(--accent-primary);
    outline-offset: -2px;
  }

  /* === Aurora ("Friday is thinking") =====================================
     Two conic-gradient layers that flow around the input bar while a turn
     is in flight. Outer extends past the wrap and is heavily blurred so
     it bleeds into the chrome; inner is clipped to the wrap's rounded
     rect via clip-path so the soft tint inside stays inside the box.
     Both layers always exist; opacity fades in/out via .busy on the wrap.
     The two @property declarations let the conic gradient's `from` angle
     animate smoothly — a plain custom property would step, not tween. */
  @property --friday-rotate-outer {
    syntax: "<angle>";
    initial-value: 0deg;
    inherits: false;
  }
  /* Three-layer aurora:
       .aurora — owns blur, opacity, and the size container. container-
                 type:size lets the inner shape read this box's dimensions
                 via cqw/cqh so the scaleX compensation is dynamic.
       .aurora-mask — owns the frame mask + padding so only the outer
                 ring + small inner bleed shows. The mask cuts before
                 .aurora's blur fires (filter on the parent fires AFTER
                 children render), so the inner cutoff blurs softly.
       .aurora-shape — renders the conic in a SQUARE coordinate system
                 (height:100%, aspect-ratio:1/1 → square at the box's
                 height) then scales horizontally by the box's
                 width/height ratio. The conic's angle math is computed
                 in the square's own coords, so a wide rect's top edge
                 spans only ~90° of the gradient instead of ~180°,
                 making each color band visually wider on top/bottom. */
  .aurora {
    position: absolute;
    inset: -10px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 500ms ease;
    z-index: 0;
    /* Reduced from 14px → 8px so the conic arcs read as defined bands
       outside the wrap; the wrap's translucent ::before adds a second
       backdrop-blur pass on the slice that sits inside the wrap, so
       the inside still reads as soft. */
    filter: blur(8px);
    container-type: size;
  }
  .input-wrap.busy .aurora { opacity: 1; }
  .aurora-mask {
    position: absolute;
    inset: 0;
    padding: 14px;
    box-sizing: border-box;
    border-radius: calc(var(--radius-md) + 10px);
    -webkit-mask:
      linear-gradient(#000 0 0) padding-box,
      linear-gradient(#000 0 0) content-box;
    -webkit-mask-composite: xor;
    mask:
      linear-gradient(#000 0 0) padding-box,
      linear-gradient(#000 0 0) content-box;
    mask-composite: exclude;
    overflow: visible;
  }
  .aurora-shape {
    position: absolute;
    /* Square at the parent's height — width auto-derived to equal
       height via aspect-ratio. Centered horizontally with translateX
       then stretched horizontally by the parent's aspect ratio so the
       rendered square fills the wide rect. The conic gradient inside
       computes angles in the square's own coord space, then those
       angles get visually stretched horizontally — virtually turning
       the conic's apex into a horizontal line. */
    height: 100%;
    aspect-ratio: 1 / 1;
    top: 0;
    left: 50%;
    transform: translateX(-50%) scaleX(calc(100cqw / 100cqh));
    transform-origin: center;
    /* Force the shape to stay on its own dynamic compositing layer for
       the entire animation lifetime. Without this, Chromium and Safari
       were observed to cache the post-mask rasterization mid-animation
       and then only invalidate the inner region per frame — freezing
       the outer ring while the inner band kept moving. Hinting that
       transform changes is enough to keep the layer dirty-tracked even
       though our actual animation is on a custom property. */
    will-change: transform;
    background: conic-gradient(
      from var(--friday-rotate-outer),
      var(--friday-blue) 0deg,
      transparent 80deg,
      var(--friday-purple) 130deg,
      transparent 220deg,
      var(--friday-pink) 260deg,
      transparent 330deg,
      var(--friday-blue) 360deg
    );
    animation: friday-rotate-outer 9s linear infinite;
  }
  @keyframes friday-rotate-outer {
    to { --friday-rotate-outer: 360deg; }
  }
  /* Reduced motion: a slow opacity pulse on the wrap border replaces the
     rotating gradients. Same "Friday is working" signal, no parallax. */
  @media (prefers-reduced-motion: reduce) {
    .aurora { display: none; }
    .input-wrap.busy {
      animation: friday-pulse 2.4s ease-in-out infinite;
    }
    @keyframes friday-pulse {
      0%, 100% { box-shadow: 0 0 0 1px var(--friday-blue); }
      50% { box-shadow: 0 0 0 2px var(--friday-purple); }
    }
  }
  .drop-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-glow);
    color: var(--accent-primary);
    font-weight: 600;
    border-radius: var(--radius-md);
    pointer-events: none;
    z-index: 5;
  }
  .hidden-file { display: none; }
  /* Icon buttons share one base style (paperclip / send / stop). The
     border-radius is the wrap radius minus the row padding so the corners
     stay concentric with the outer box. */
  .icon-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: calc(var(--radius-md) - 5px);
    color: var(--text-secondary);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast),
      opacity var(--transition-fast);
  }
  .icon-btn:hover:not(:disabled) {
    background: var(--bg-tertiary);
  }
  .icon-btn:focus-visible {
    outline: none;
    background: var(--bg-tertiary);
  }
  .icon-btn.attach { color: var(--text-secondary); }
  .icon-btn.attach:hover:not(:disabled) { color: var(--text-primary); }
  .icon-btn.send { color: var(--text-primary); }
  .icon-btn.send:disabled {
    color: var(--text-primary);
    opacity: 0.35;
    cursor: not-allowed;
  }
  .icon-btn.stop { color: var(--status-error); }
  .icon-btn.stop:hover:not(:disabled) {
    color: var(--status-error);
  }
  /* Stopping: the user already clicked Stop; we're waiting for the daemon
     to confirm. The button stays in place (no jump back to Send) but
     dims so a second click is visibly inert. The aurora animation on
     the wrap keeps running until turn_done lands. */
  .icon-btn.stop.stopping {
    color: var(--status-error);
    opacity: 0.45;
    cursor: not-allowed;
  }
  .chips {
    position: relative;
    /* Sits above the aurora (z-index: 0) and the translucent
       backdrop-blur pseudo (z-index: 1) so attachment chips remain
       crisp while the gradient flows behind. */
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    padding: 0.45rem 0.5rem;
  }
  /* Inset the divider to match the row's horizontal padding so it doesn't
     touch the wrap's rounded edges. A pseudo-element keeps the rule
     declarative — no border-image gymnastics. */
  .chips::after {
    content: "";
    position: absolute;
    left: 0.5rem;
    right: 0.5rem;
    bottom: 0;
    height: 1px;
    background: var(--border-subtle);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.4rem 0.25rem 0.5rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    font-size: 0.75rem;
    max-width: 14rem;
  }
  .chip.err {
    border-color: var(--status-error);
    color: var(--status-error);
  }
  .chip-thumb {
    width: 1.5rem;
    height: 1.5rem;
    object-fit: cover;
    border-radius: 50%;
  }
  .chip-icon { line-height: 1; }
  .chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip-status { font-size: 0.7rem; }
  .chip-remove {
    border: none;
    background: transparent;
    color: var(--text-tertiary);
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.25rem;
    border-radius: 50%;
  }
  .chip-remove:hover {
    background: var(--bg-card);
    color: var(--text-primary);
  }
  .input {
    /* Lift the textarea + buttons above the aurora (z-index: 0) and
       the translucent backdrop-blur pseudo (z-index: 1). */
    position: relative;
    z-index: 2;
    display: flex;
    gap: 0.25rem;
    align-items: flex-end;
    /* Padding sets the visual inset of the children inside the bordered
       wrap. Concentric icon-button radius (above) is computed from this. */
    padding: 0.5rem;
    background: transparent;
  }
  textarea {
    flex: 1;
    resize: none;
    /* No border, no background — the wrap owns the chrome. Vertical
       padding sized so a single-row textarea matches the 2rem icon button
       height (with align-items: flex-end keeping them aligned when the
       textarea grows). */
    padding: 0.35rem 0.5rem;
    line-height: 1.4;
    overflow-y: auto;
    max-height: 50vh;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 0.9rem;
  }
  textarea:focus { outline: none; }
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
  /* FIX_FORWARD 6.2: passive selection (selectedIdx default) is subtle;
     the active state — when the user has arrow-key'd into the menu —
     paints with the accent so it reads as the focused row. */
  .row.selected,
  .row:hover {
    background: var(--bg-card-hover);
  }
  .row.active {
    background: var(--accent-glow);
    box-shadow: inset 2px 0 0 var(--accent-primary);
  }
  /* When nav has transferred into the menu, hide the textarea's caret so
     the user has a clear visual that Enter applies the highlight. */
  textarea.nav-in-menu {
    caret-color: transparent;
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
       Icon buttons don't host text, so they don't need the matching bump
       — width/height are the same; the textarea row just gets taller and
       align-items: flex-end keeps the icons pinned to the bottom row. */
    textarea { font-size: 16px; }
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
