<script lang="ts">
  import { marked } from "marked";
  import DOMPurify from "isomorphic-dompurify";
  import { onMount } from "svelte";
  import { getMarkedExtensions } from "@friday/shared/markdown";
  import "katex/dist/katex.min.css";

  let { source }: { source: string | null | undefined } = $props();

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
    // KaTeX emits MathML; allow it. The mermaid marker is a plain <pre class>.
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true, mathMl: true, svg: true } });
  });

  // After every render, rescan for `.mermaid` blocks and mount diagrams. The
  // mermaid library is loaded once on first need.
  let container: HTMLDivElement;
  let mermaidLoaded = false;
  type MermaidApi = {
    initialize: (cfg: Record<string, unknown>) => void;
    run: (opts: { nodes: HTMLElement[] }) => Promise<void>;
  };
  let mermaidApi: MermaidApi | null = null;

  async function renderMermaid() {
    if (!container) return;
    const blocks = Array.from(
      container.querySelectorAll<HTMLElement>("pre.mermaid:not([data-mermaid-rendered])"),
    );
    if (blocks.length === 0) return;
    if (!mermaidApi) {
      const mod = await import("mermaid");
      mermaidApi = (mod.default ?? (mod as unknown)) as MermaidApi;
      mermaidApi.initialize({ startOnLoad: false, securityLevel: "strict" });
      mermaidLoaded = true;
    }
    // Mark before run so re-renders during the same `source` don't double-mount.
    for (const b of blocks) b.setAttribute("data-mermaid-rendered", "true");
    try {
      await mermaidApi.run({ nodes: blocks });
    } catch (err) {
      // On parse error, mermaid leaves an error message inline; surface to
      // console for debug.
      // eslint-disable-next-line no-console
      console.warn("mermaid render failed:", err);
    }
  }

  $effect(() => {
    // Recompute on html change. Microtask defer so `{@html}` has flushed.
    void html;
    queueMicrotask(renderMermaid);
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
