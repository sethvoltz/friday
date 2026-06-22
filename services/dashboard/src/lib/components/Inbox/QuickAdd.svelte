<script lang="ts">
  /**
   * FRI-171 (ADR-047) — the PWA quick-add Capture box.
   *
   * A COMPACT capture input (NOT the full chat) placed near the Today card.
   * Submitting POSTs the raw text to the SAME stateless intake the Watch
   * capture route hits — here via the dashboard's session-authenticated
   * `/api/capture` proxy with `source: "quick_add"` (no capture key needed; the
   * session cookie authenticates). The returned `{ cleaned, disposition,
   * rationale }` is surfaced as an inline toast so the user sees where the
   * Capture landed. The new Inbox row arrives live in the bell via Zero.
   */

  let text = $state("");
  let busy = $state(false);
  let toast = $state<{ msg: string; kind: "ok" | "err" } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function showToast(msg: string, kind: "ok" | "err" = "ok"): void {
    toast = { msg, kind };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 6000);
  }

  async function submit(): Promise<void> {
    const t = text.trim();
    if (!t || busy) return;
    busy = true;
    try {
      const r = await fetch("/api/capture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t, source: "quick_add" }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        cleaned?: string;
        disposition?: "act" | "propose";
        rationale?: string;
        error?: string;
      };
      if (!r.ok && r.status !== 202) {
        showToast(body.error ?? `capture failed (${r.status})`, "err");
        return;
      }
      text = "";
      const where = body.disposition === "act" ? "Done" : "staged for review";
      showToast(body.rationale ? `${where} — ${body.rationale}` : `Captured (${where})`);
    } catch {
      showToast("capture failed — network error", "err");
    } finally {
      busy = false;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    // Enter submits; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }
</script>

<div class="card quick-add" data-testid="quick-add">
  <div class="qa-row">
    <textarea
      class="qa-input"
      placeholder="Throw a thought at Friday…"
      bind:value={text}
      onkeydown={onKeydown}
      rows="1"
      aria-label="Quick capture"
      disabled={busy}></textarea>
    <button
      type="button"
      class="qa-send"
      onclick={submit}
      disabled={busy || text.trim().length === 0}>
      {busy ? "…" : "Capture"}
    </button>
  </div>
  {#if toast}
    <p class="qa-toast qa-toast-{toast.kind}" role="status" aria-live="polite">{toast.msg}</p>
  {/if}
</div>

<style>
  .quick-add {
    padding: 0.6rem 0.75rem;
  }
  .qa-row {
    display: flex;
    gap: 0.5rem;
    align-items: stretch;
  }
  .qa-input {
    flex: 1 1 auto;
    resize: none;
    min-height: 2.2rem;
    max-height: 8rem;
    padding: 0.5rem 0.6rem;
    font-size: 0.85rem;
    font-family: inherit;
    line-height: 1.4;
    color: var(--text-primary);
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
  }
  .qa-input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }
  .qa-send {
    flex-shrink: 0;
    padding: 0 0.9rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--accent-primary);
    background: var(--accent-glow);
    border: 1px solid var(--accent-primary);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: opacity var(--transition-fast);
  }
  .qa-send:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .qa-toast {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }
  .qa-toast-err {
    color: var(--danger, #e5484d);
  }
</style>
