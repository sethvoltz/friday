<script lang="ts">
  import { marked } from "marked";
  import DOMPurify from "isomorphic-dompurify";
  import { onMount } from "svelte";
  import { getMarkedExtensions } from "@friday/shared/markdown";
  import {
    applyStreamingMermaidGate,
    invalidateRenderedMermaid,
  } from "@friday/shared/markdown/streaming-mermaid";
  import { theme } from "$lib/stores/theme.svelte";
  import "katex/dist/katex.min.css";

  let {
    source,
    streaming = false,
  }: { source: string | null | undefined; streaming?: boolean } = $props();

  // Install KaTeX + mermaid marker extension once. Module-level: every
  // Markdown instance shares the same `marked` configuration.
  let installed = false;
  function ensureInstalled() {
    if (installed) return;
    marked.use(...getMarkedExtensions());
    installed = true;
  }
  ensureInstalled();

  const html = $derived.by(() => {
    const raw = marked.parse(source ?? "", { gfm: true, breaks: true, async: false }) as string;
    // KaTeX emits MathML; allow it. The mermaid marker is a plain
    // <pre class="mermaid">…</pre> placeholder that the post-DOMPurify
    // pass swaps for a rendered diagram, so we do NOT need to allow raw
    // SVG through DOMPurify (FIX_FORWARD 5.2 — narrowing the surface
    // closes a class of SVG-borne XSS / use-after-paint vectors).
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true, mathMl: true } });
  });

  // After every render, route unmounted `.mermaid` blocks through the gate,
  // which decides which are safe to render now and marks the rest as
  // pending placeholders.
  let container: HTMLDivElement;
  let mermaidLoaded = false;
  type MermaidApi = {
    initialize: (cfg: Record<string, unknown>) => void;
    parse: (text: string, opts: { suppressErrors: true }) => Promise<unknown>;
    run: (opts: { nodes: HTMLElement[] }) => Promise<void>;
  };
  let mermaidApi: MermaidApi | null = null;

  async function renderMermaid() {
    if (!container) return;
    // Cheap pre-check: nothing to do if there are no unmounted mermaid
    // blocks. Avoids the dynamic import on prose-only renders.
    const hasUnmounted = container.querySelector(
      "pre.mermaid:not([data-mermaid-rendered])",
    );
    if (!hasUnmounted) return;
    if (!mermaidApi) {
      const mod = await import("mermaid");
      mermaidApi = (mod.default ?? (mod as unknown)) as MermaidApi;
      mermaidLoaded = true;
    }
    // Mermaid stamps colors into the SVG at render time, so the theme has
    // to be set before each `run()`. Re-calling initialize is idempotent
    // and is the documented way to swap themes between renders.
    mermaidApi.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme.current === "dark" ? "dark" : "default",
    });
    const toRun = await applyStreamingMermaidGate(container, {
      streaming,
      parse: (t) => mermaidApi!.parse(t, { suppressErrors: true }),
    });
    if (toRun.length === 0) return;
    try {
      await mermaidApi.run({ nodes: toRun });
    } catch (err) {
      // On parse error, mermaid leaves an error message inline; surface to
      // console for debug.
      // eslint-disable-next-line no-console
      console.warn("mermaid render failed:", err);
    }
  }

  // Track the theme-version this component has rendered against, so the
  // effect can tell a "theme actually changed" tick apart from a normal
  // re-render tick (html / streaming change). Only the former needs to
  // invalidate existing diagrams; the latter would needlessly thrash.
  let lastThemeVersion = -1;

  $effect(() => {
    // Re-fire on html change, streaming flip, OR theme toggle. Microtask
    // defer so `{@html}` has flushed before we walk the DOM. Streaming →
    // complete transitions retry any block that was pending purely on
    // the trailing gate. Theme toggles invalidate all rendered diagrams
    // so the next renderMermaid pass re-runs them against the new theme.
    void html;
    void streaming;
    const tv = theme.version;
    const themeChanged = tv !== lastThemeVersion && lastThemeVersion !== -1;
    lastThemeVersion = tv;
    queueMicrotask(() => {
      if (themeChanged && container) invalidateRenderedMermaid(container);
      void renderMermaid();
    });
  });

  onMount(() => {
    void mermaidLoaded;
    renderMermaid();
  });
</script>

<div class="markdown" bind:this={container}>{@html html}</div>

<style>
  :global(.markdown) {
    color: var(--text-primary);
    font-size: 0.85rem;
    line-height: 1.55;
    word-wrap: break-word;
    white-space: normal;
  }

  :global(.markdown > *:first-child) { margin-top: 0; }
  :global(.markdown > *:last-child) { margin-bottom: 0; }

  :global(.markdown p) { margin: 0.5rem 0; }

  :global(.markdown h1),
  :global(.markdown h2),
  :global(.markdown h3),
  :global(.markdown h4),
  :global(.markdown h5),
  :global(.markdown h6) {
    margin: 1rem 0 0.5rem;
    font-weight: 600;
    color: var(--text-primary);
    line-height: 1.3;
  }
  :global(.markdown h1) { font-size: 1.15rem; }
  :global(.markdown h2) { font-size: 1.05rem; }
  :global(.markdown h3) { font-size: 0.95rem; }
  :global(.markdown h4),
  :global(.markdown h5),
  :global(.markdown h6) { font-size: 0.85rem; }

  :global(.markdown ul),
  :global(.markdown ol) {
    margin: 0.5rem 0;
    padding-left: 1.4rem;
  }
  :global(.markdown li) { margin: 0.2rem 0; }
  :global(.markdown li > p) { margin: 0.25rem 0; }

  :global(.markdown blockquote) {
    margin: 0.5rem 0;
    padding: 0.25rem 0.75rem;
    border-left: 3px solid var(--border-subtle);
    color: var(--text-secondary);
  }

  :global(.markdown code) {
    font-family: var(--font-mono);
    font-size: 0.8em;
    padding: 0.1rem 0.3rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm, 4px);
  }

  :global(.markdown pre) {
    margin: 0.5rem 0;
    padding: 0.75rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    overflow-x: auto;
  }
  :global(.markdown pre code) {
    padding: 0;
    background: transparent;
    border: none;
    font-size: 0.78rem;
    line-height: 1.5;
  }

  /* Mermaid renders SVG into the pre.mermaid block; let it breathe. */
  :global(.markdown pre.mermaid) {
    background: transparent;
    border: 1px solid var(--border-subtle);
    text-align: center;
    overflow-x: auto;
  }
  :global(.markdown pre.mermaid svg) {
    max-width: 100%;
    height: auto;
  }

  /* Placeholder shown while a streamed mermaid block is still arriving or
     is mid-syntax-error. The partial source is hidden (font-size: 0) and a
     ::before pseudo carries a muted, slowly-pulsing label. When the block
     resolves to a real render, mermaid replaces the textContent with an
     <svg>, the pending attribute clears, and the placeholder vanishes. */
  :global(.markdown pre.mermaid[data-mermaid-pending="true"]) {
    font-size: 0;
    line-height: 1.4;
    color: var(--text-secondary);
    padding: 1rem;
  }
  :global(.markdown pre.mermaid[data-mermaid-pending="true"])::before {
    content: "Rendering Mermaid diagram…";
    display: inline-block;
    font-family: inherit;
    font-size: 0.8rem;
    font-style: italic;
    color: var(--text-secondary);
    animation: mermaid-pending-pulse 3s ease-in-out infinite;
  }
  @keyframes mermaid-pending-pulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
  }

  :global(.markdown a) {
    color: var(--accent, #60a5fa);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  :global(.markdown a:hover) { text-decoration: none; }

  :global(.markdown table) {
    border-collapse: collapse;
    margin: 0.5rem 0;
    font-size: 0.8rem;
  }
  :global(.markdown th),
  :global(.markdown td) {
    padding: 0.35rem 0.6rem;
    border: 1px solid var(--border-subtle);
    text-align: left;
  }
  :global(.markdown th) {
    background: var(--bg-secondary);
    font-weight: 600;
  }

  :global(.markdown hr) {
    border: none;
    border-top: 1px solid var(--border-subtle);
    margin: 1rem 0;
  }

  :global(.markdown strong) { font-weight: 600; }
  :global(.markdown em) { font-style: italic; }

  :global(.markdown img) { max-width: 100%; height: auto; }
</style>
