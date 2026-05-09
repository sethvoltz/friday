<script lang="ts">
  import { onMount } from "svelte";

  let active = $state<"daemon" | "dashboard">("daemon");
  let lines = $state<string[]>([]);
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let scrollEl: HTMLElement | undefined = $state();

  async function poll() {
    try {
      const r = await fetch(`/api/logs/${active}?n=200`);
      if (r.ok) {
        lines = (await r.json()) as string[];
        queueMicrotask(() => {
          if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
        });
      }
    } catch {
      // ignore
    }
  }

  onMount(() => {
    void poll();
    pollHandle = setInterval(poll, 2000);
    return () => {
      if (pollHandle) clearInterval(pollHandle);
    };
  });

  $effect(() => {
    active;
    void poll();
  });

  function fmtLine(l: string): string {
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      const t = String(o.ts ?? "").slice(11, 19);
      const lvl = String(o.level ?? "info");
      const ev = String(o.event ?? "");
      const rest = Object.entries(o)
        .filter(([k]) => !["ts", "level", "service", "event"].includes(k))
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      return `${t} ${lvl.padEnd(5)} ${ev} ${rest}`.trim();
    } catch {
      return l;
    }
  }

  function lineClass(l: string): string {
    try {
      const o = JSON.parse(l);
      return String(o.level ?? "info");
    } catch {
      return "";
    }
  }
</script>

<header class="page-head">
  <h1>Logs</h1>
  <p class="page-lead">Live tail of the JSONL log files.</p>
</header>

<div class="card">
  <div class="card-header">
    <h2>{active}.jsonl</h2>
    <div class="tabs">
      <button class="ghost" class:active={active === "daemon"} onclick={() => (active = "daemon")}>daemon</button>
      <button class="ghost" class:active={active === "dashboard"} onclick={() => (active = "dashboard")}>dashboard</button>
    </div>
  </div>
  <div class="log-scroll" bind:this={scrollEl}>
    {#each lines as l}
      <div class="log-line {lineClass(l)}">{fmtLine(l)}</div>
    {/each}
    {#if lines.length === 0}
      <p class="empty-state">No log entries yet.</p>
    {/if}
  </div>
</div>

<style>
  .tabs { display: flex; gap: 0.4rem; }
  .tabs .active {
    background: var(--accent-primary);
    color: var(--text-inverse);
    border-color: var(--accent-primary);
  }
  .log-scroll {
    max-height: 70vh;
    overflow-y: auto;
    background: var(--bg-code);
    border-radius: var(--radius-sm);
    padding: 0.75rem;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    line-height: 1.5;
  }
  .log-line {
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .log-line.warn { color: var(--status-warn); }
  .log-line.error { color: var(--status-error); }
</style>
