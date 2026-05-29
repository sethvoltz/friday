<script lang="ts">
  import { onMount } from "svelte";

  // Order matches `friday status` so operators see the same column
  // order in both surfaces. `tunnel` is cloudflared's plain-text log
  // (everything else is JSONL); `fmtLine` falls back to the raw line
  // on a parse failure so the mixed-format case still renders.
  type LogService = "daemon" | "dashboard" | "zero-cache" | "tunnel";
  const SERVICES: LogService[] = ["daemon", "dashboard", "zero-cache", "tunnel"];
  let active = $state<LogService>("daemon");
  let lines = $state<string[]>([]);
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let scrollEl: HTMLElement | undefined = $state();

  // Stick-to-bottom: each poll snapshots whether the user was within
  // STICK_PX of the bottom BEFORE the new lines land — if they were, the
  // tail keeps following; if they'd scrolled up to read history, the
  // scroll position is left alone. Threshold is a few lines so users
  // who land just short of the absolute bottom still get carried along.
  // `forceStickNext` overrides on tab switch (the prior tab's scroll
  // position is irrelevant once you ask for a different service).
  const STICK_PX = 32;
  let forceStickNext = true;

  async function poll() {
    try {
      const r = await fetch(`/api/logs/${active}?n=200`);
      if (r.ok) {
        const stick =
          forceStickNext ||
          !scrollEl ||
          scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < STICK_PX;
        lines = (await r.json()) as string[];
        queueMicrotask(() => {
          if (stick && scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
          forceStickNext = false;
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
    forceStickNext = true;
    void poll();
  });

  // zero-cache emits `{level:"INFO", pid, worker, workerIndex, message,
  // ...}` with no `ts` field and uppercase level names, whereas the daemon
  // + dashboard loggers emit `{ts, level:"info", service, event, ...}`.
  // Normalize both shapes through one renderer: prefer `event`, fall back
  // to `message`; lowercase the level so the CSS class selectors still
  // hit; collapse zero-cache's noisy `pid`/`worker`/`workerIndex` into a
  // single `[pid/worker]` token to keep one log line per row.
  function fmtLine(l: string): string {
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      const t = String(o.ts ?? "").slice(11, 19);
      const lvl = String(o.level ?? "info").toLowerCase();
      const ev = String(o.event ?? o.message ?? "");
      const zeroPrefix =
        typeof o.pid === "number" && typeof o.worker === "string"
          ? `[${o.pid}/${o.worker}${
              typeof o.workerIndex === "number" ? `#${o.workerIndex}` : ""
            }] `
          : "";
      const rest = Object.entries(o)
        .filter(
          ([k]) =>
            ![
              "ts",
              "level",
              "service",
              "event",
              "message",
              "pid",
              "worker",
              "workerIndex",
            ].includes(k),
        )
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      return `${t} ${lvl.padEnd(5)} ${zeroPrefix}${ev} ${rest}`.trim();
    } catch {
      return l;
    }
  }

  function lineClass(l: string): string {
    try {
      const o = JSON.parse(l);
      return String(o.level ?? "info").toLowerCase();
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
    <h2>{active}.{active === "tunnel" ? "log" : "jsonl"}</h2>
    <div class="tabs">
      {#each SERVICES as svc}
        <button class="ghost" class:active={active === svc} onclick={() => (active = svc)}>{svc}</button>
      {/each}
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
