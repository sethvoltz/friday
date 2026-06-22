<script lang="ts">
  /**
   * FRI-171 (ADR-047) — the Settings "Capture keys" card.
   *
   * Lists the user's Capture keys (label / prefix / last-used), creates a new
   * one (the plaintext key is shown ONCE via the project modal), and revokes a
   * key behind a ConfirmDialog. All operations go through the session-gated
   * `/api/capture-keys` REST (the authenticated counterpart to the key-gated
   * `/api/capture` endpoint). The plaintext key is never recoverable after the
   * one-time reveal — the list view carries only the non-secret prefix/start.
   */
  import { onMount } from "svelte";
  import { confirmDialog } from "$lib/components/ConfirmDialog/store.svelte";
  import { Copy, KeyRound, Trash2 } from "lucide-svelte";

  interface CaptureKeyView {
    id: string;
    name: string | null;
    start: string | null;
    prefix: string | null;
    enabled: boolean;
    createdAt: string;
    lastRequest: string | null;
    expiresAt: string | null;
  }

  let keys = $state<CaptureKeyView[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let newLabel = $state("");
  let creating = $state(false);
  /** The just-minted plaintext key, shown once in the reveal modal. */
  let revealed = $state<string | null>(null);
  let copied = $state(false);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const r = await fetch("/api/capture-keys");
      if (!r.ok) throw new Error(`list failed (${r.status})`);
      const body = (await r.json()) as { keys: CaptureKeyView[] };
      keys = body.keys;
    } catch (e) {
      error = e instanceof Error ? e.message : "failed to load keys";
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function create(): Promise<void> {
    if (creating) return;
    creating = true;
    error = null;
    try {
      const r = await fetch("/api/capture-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newLabel.trim() || undefined }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        key?: string;
        view?: CaptureKeyView;
        error?: string;
      };
      if (!r.ok || !body.key) throw new Error(body.error ?? `create failed (${r.status})`);
      revealed = body.key;
      copied = false;
      newLabel = "";
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "failed to create key";
    } finally {
      creating = false;
    }
  }

  async function revoke(key: CaptureKeyView): Promise<void> {
    const ok = await confirmDialog({
      title: "Revoke this capture key?",
      description: `"${key.name ?? key.prefix ?? key.id}" will stop working immediately. Any Watch shortcut using it must be re-keyed.`,
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!ok) return;
    error = null;
    try {
      const r = await fetch(`/api/capture-keys?id=${encodeURIComponent(key.id)}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(`revoke failed (${r.status})`);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "failed to revoke key";
    }
  }

  async function copyRevealed(): Promise<void> {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      copied = true;
    } catch {
      copied = false;
    }
  }

  function fmtDate(iso: string | null): string {
    if (!iso) return "never";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
  }
</script>

<div class="card">
  <div class="card-header"><h2>Capture keys</h2></div>
  <p class="row-value">
    Token keys for the stateless capture endpoint (Apple Watch shortcut, scripts). Each key carries
    only the <code>capture:write</code> scope and mints no session.
  </p>

  {#if error}
    <p class="ck-error" role="alert">{error}</p>
  {/if}

  <div class="ck-create">
    <input
      class="ck-label"
      type="text"
      placeholder="Label (e.g. Apple Watch)"
      bind:value={newLabel}
      disabled={creating} />
    <button class="primary" onclick={create} disabled={creating}>
      <KeyRound size={14} strokeWidth={2} aria-hidden="true" />
      {creating ? "Creating…" : "Create key"}
    </button>
  </div>

  {#if loading}
    <p class="row-value muted">Loading…</p>
  {:else if keys.length === 0}
    <p class="row-value muted">No capture keys yet.</p>
  {:else}
    <ul class="ck-list">
      {#each keys as key (key.id)}
        <li class="ck-row">
          <div class="ck-meta">
            <span class="ck-name">{key.name ?? "Capture key"}</span>
            <span class="ck-prefix">{key.prefix ?? key.start ?? ""}…</span>
            <span class="muted">last used {fmtDate(key.lastRequest)}</span>
          </div>
          <button class="ghost ck-revoke" aria-label="Revoke key" onclick={() => revoke(key)}>
            <Trash2 size={14} strokeWidth={2} aria-hidden="true" /> Revoke
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<!-- One-time plaintext reveal modal. Uses the same overlay pattern as the
     project's dialogs (never window.alert). -->
{#if revealed}
  <div
    class="ck-modal-backdrop"
    role="presentation"
    onclick={() => (revealed = null)}
    onkeydown={(e) => {
      if (e.key === "Escape") revealed = null;
    }}>
    <div
      class="ck-modal"
      role="dialog"
      aria-modal="true"
      aria-label="New capture key"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}>
      <h3>Your new capture key</h3>
      <p class="ck-modal-warn">
        Copy it now — it is shown only once and cannot be recovered.
      </p>
      <div class="ck-key-box">
        <code>{revealed}</code>
        <button class="ghost" onclick={copyRevealed}>
          <Copy size={14} strokeWidth={2} aria-hidden="true" />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div class="actions">
        <button class="primary" onclick={() => (revealed = null)}>Done</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .ck-error {
    color: var(--danger, #e5484d);
    font-size: 0.8rem;
  }
  .ck-create {
    display: flex;
    gap: 0.5rem;
    margin: 0.5rem 0 0.75rem;
  }
  .ck-label {
    flex: 1 1 auto;
    padding: 0.4rem 0.6rem;
    font-size: 0.85rem;
    color: var(--text-primary);
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
  }
  .ck-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .ck-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0;
    border-top: 1px solid var(--border-primary);
  }
  .ck-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
    font-size: 0.8rem;
  }
  .ck-name {
    font-weight: 600;
    color: var(--text-primary);
  }
  .ck-prefix {
    font-family: var(--font-mono, monospace);
    color: var(--text-secondary);
  }
  .ck-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }
  .ck-modal {
    width: min(28rem, 92vw);
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    padding: 1.25rem;
  }
  .ck-modal h3 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
  }
  .ck-modal-warn {
    font-size: 0.8rem;
    color: var(--text-secondary);
    margin: 0 0 0.75rem;
  }
  .ck-key-box {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.6rem;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    margin-bottom: 1rem;
  }
  .ck-key-box code {
    flex: 1 1 auto;
    word-break: break-all;
    font-size: 0.8rem;
    color: var(--text-primary);
  }
</style>
