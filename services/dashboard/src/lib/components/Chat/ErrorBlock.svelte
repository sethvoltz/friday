<script lang="ts">
  import { onDestroy } from "svelte";
  import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-svelte";

  interface Props {
    /** User-facing one-liner: "Anthropic temporarily overloaded — …". */
    headline: string;
    /** Stable code: `overloaded`, `rate_limited`, `unauthorized`, …. */
    code: string;
    /** When the error block was emitted. The retry-after countdown is
     *  computed against this timestamp so a reload mid-rate-limit shows
     *  the right remaining time. */
    ts: number;
    /** Seconds the SDK suggested waiting before retry. Drives the
     *  countdown. Undefined → no countdown rendered, Resume always
     *  enabled. */
    retryAfterSeconds?: number;
    httpStatus?: number;
    requestId?: string;
    rawMessage?: string;
    /** Disable Resend (no original prompt resolvable, or already busy). */
    canResend: boolean;
    /** Disable Resume (e.g. 401 — re-dispatch won't help; or agent busy). */
    canResume: boolean;
    onResend: () => void;
    onResume: () => void;
  }

  const {
    headline,
    code,
    ts,
    retryAfterSeconds,
    httpStatus,
    requestId,
    rawMessage,
    canResend,
    canResume,
    onResend,
    onResume,
  }: Props = $props();

  let detailsOpen = $state(false);

  // Retry-after countdown. Refreshes every second while > 0; falls
  // through to a static label under reduce-motion. The countdown is
  // computed from the original `ts` so reload-mid-rate-limit shows the
  // correct remaining time.
  let prefersReducedMotion = $state(false);
  if (typeof window !== "undefined") {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    prefersReducedMotion = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      prefersReducedMotion = e.matches;
    };
    mq.addEventListener("change", onChange);
    onDestroy(() => mq.removeEventListener("change", onChange));
  }

  let now = $state(Date.now());
  let tickHandle: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    if (retryAfterSeconds === undefined || retryAfterSeconds <= 0) return;
    // The countdown is a value update, not an animation — reduce-motion
    // shouldn't freeze it (that would leave Resume permanently disabled).
    // Instead we suppress aria-live announcements via the `aria-live="off"`
    // path below so screen readers aren't barked at every second.
    tickHandle = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => {
      if (tickHandle) clearInterval(tickHandle);
      tickHandle = null;
    };
  });

  let remainingSeconds = $derived.by(() => {
    if (retryAfterSeconds === undefined) return 0;
    const elapsed = Math.floor((now - ts) / 1000);
    const remaining = retryAfterSeconds - elapsed;
    return remaining > 0 ? remaining : 0;
  });

  // Resume disabled while waiting on the retry-after window. Resend
  // remains available — sending a new turn isn't subject to the same
  // rate window in the user's mental model (and the new POST will hit
  // the SDK's own backoff if necessary).
  let resumeEnabled = $derived(canResume && remainingSeconds === 0);

  function fmtCountdown(seconds: number): string {
    if (seconds >= 60) {
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return `${m}m ${s}s`;
    }
    return `${seconds}s`;
  }
</script>

<div class="error-block" data-code={code}>
  <div class="error-head">
    <span class="error-icon" aria-hidden="true"><AlertTriangle size={16} /></span>
    <span class="headline">{headline}</span>
    {#if remainingSeconds > 0}
      <span
        class="countdown"
        aria-live={prefersReducedMotion ? "off" : "polite"}>
        Try again in {fmtCountdown(remainingSeconds)}
      </span>
    {/if}
  </div>
  <div class="error-actions">
    <button
      type="button"
      class="error-cta"
      onclick={onResend}
      disabled={!canResend}
      title="Send the original message as a new turn">
      <RefreshCw size={12} />
      <span>Resend</span>
    </button>
    <button
      type="button"
      class="error-cta"
      onclick={onResume}
      disabled={!resumeEnabled}
      title={resumeEnabled
        ? "Re-dispatch under the same turn id"
        : remainingSeconds > 0
          ? "Waiting for rate-limit to clear"
          : "Resume not available for this error"}>
      <RotateCcw size={12} />
      <span>Resume</span>
    </button>
    <button
      type="button"
      class="details-toggle"
      onclick={() => (detailsOpen = !detailsOpen)}
      aria-expanded={detailsOpen}>
      Details {detailsOpen ? "−" : "+"}
    </button>
  </div>
  {#if detailsOpen}
    <div class="error-details">
      <div class="meta">
        {#if httpStatus !== undefined}<span>HTTP {httpStatus}</span>{/if}
        <span>Code {code}</span>
        {#if requestId}<span>req {requestId}</span>{/if}
      </div>
      {#if rawMessage}
        <pre class="raw-pre"><code>{rawMessage}</code></pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  .error-block {
    border-left: 2px solid var(--status-error);
    background: color-mix(in oklab, var(--status-error) 6%, transparent);
    border-radius: var(--radius-sm);
    padding: 0.4rem 0.6rem;
    font-size: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .error-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .error-icon {
    display: inline-flex;
    color: var(--status-error);
  }
  .headline {
    color: var(--text-primary);
    font-weight: 500;
    flex: 1 1 auto;
    min-width: 0;
  }
  .countdown {
    color: var(--text-tertiary);
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .error-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .error-cta {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.6rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.78rem;
    cursor: pointer;
  }
  .error-cta:hover:not(:disabled) {
    background: var(--bg-card);
  }
  .error-cta:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .details-toggle {
    margin-left: auto;
    background: transparent;
    border: none;
    color: var(--text-tertiary);
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0.25rem 0.4rem;
  }
  .details-toggle:hover {
    color: var(--text-secondary);
  }
  .error-details {
    margin-top: 0.25rem;
    padding: 0.4rem 0.55rem;
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
  }
  .meta {
    display: flex;
    gap: 0.6rem;
    color: var(--text-tertiary);
    font-size: 0.7rem;
    font-family: var(--font-mono);
    margin-bottom: 0.35rem;
    flex-wrap: wrap;
  }
  .raw-pre {
    margin: 0;
    padding: 0.4rem 0.55rem;
    background: var(--bg-code);
    border-radius: var(--radius-sm);
    overflow-x: auto;
    max-height: 220px;
    overflow-y: auto;
  }
  .raw-pre code {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--text-secondary);
    background: transparent;
    border: none;
    padding: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
