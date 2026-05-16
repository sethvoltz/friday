<script lang="ts">
  import { marked } from "marked";
  import DOMPurify from "isomorphic-dompurify";
  import { onMount } from "svelte";
  import { getMarkedExtensions } from "@friday/shared/markdown";
  import {
    applyStreamingMermaidGate,
    invalidateRenderedMermaid,
  } from "@friday/shared/markdown/streaming-mermaid";
  import { applyCodeHighlight } from "@friday/shared/markdown/code-highlight";
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

  // Streaming markdown re-parse is throttled to 5Hz (200ms) so deep deltas
  // don't pay the full marked + DOMPurify + shiki cost per SSE event. The
  // final state always lands: as soon as `streaming` flips to false we
  // flush immediately so the user sees the complete message without the
  // last debounce window's latency.
  const DEBOUNCE_MS = 200;
  let debouncedSource = $state<string>("");
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const src = source ?? "";
    if (!streaming) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      debouncedSource = src;
      return;
    }
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debouncedSource = source ?? "";
      debounceTimer = null;
    }, DEBOUNCE_MS);
  });

  const html = $derived.by(() => {
    const raw = marked.parse(debouncedSource, { gfm: true, breaks: true, async: false }) as string;
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

  // Shiki is dual-themed (Catppuccin Latte + Mocha) with defaultColor:false
  // so every span carries both `--shiki-light` and `--shiki-dark` CSS
  // variables. Theme switching is then pure CSS — no re-highlight on
  // toggle, unlike mermaid which bakes colors into the SVG.
  type ShikiApi = {
    codeToHtml: (
      code: string,
      opts: {
        lang: string;
        themes: { light: string; dark: string };
        defaultColor?: false;
      },
    ) => Promise<string>;
  };
  let shikiApi: ShikiApi | null = null;

  async function highlightCode() {
    if (!container) return;
    const hasUnhighlighted = container.querySelector(
      "pre > code[class*='language-']:not([data-shiki-rendered])",
    );
    if (!hasUnhighlighted) return;
    if (!shikiApi) {
      const mod = await import("shiki");
      shikiApi = mod as unknown as ShikiApi;
    }
    await applyCodeHighlight(container, {
      streaming,
      highlight: async (code, lang) => {
        const out = await shikiApi!.codeToHtml(code, {
          lang,
          themes: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
          defaultColor: false,
        });
        // Shiki returns a full <pre class="shiki"><code>…</code></pre>;
        // we only want the inner token spans so they slot into our own
        // chrome-wrapped <code> element.
        const tmp = document.createElement("div");
        tmp.innerHTML = out;
        return tmp.querySelector("code")?.innerHTML ?? "";
      },
    });
  }

  // Absolute URLs (scheme: or protocol-relative //) open in a new tab so the
  // dashboard isn't replaced when the user clicks an external reference.
  // Relative paths (`/foo`, `./foo`, `#hash`) stay in the same tab so internal
  // SvelteKit navigation keeps working.
  const ABSOLUTE_HREF = /^([a-z][a-z0-9+.\-]*:|\/\/)/i;
  function processLinks() {
    if (!container) return;
    const anchors = container.querySelectorAll<HTMLAnchorElement>("a[href]");
    for (const a of anchors) {
      if (a.dataset.linkProcessed) continue;
      const href = a.getAttribute("href") ?? "";
      if (ABSOLUTE_HREF.test(href)) {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
      a.dataset.linkProcessed = "1";
    }
  }

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
      void highlightCode();
      processLinks();
    });
  });

  onMount(() => {
    void mermaidLoaded;
    renderMermaid();
    void highlightCode();
    processLinks();
    // Delegated copy-button handler — one listener for every code block in
    // this Markdown instance. The button is emitted by codeChromeExtension
    // (packages/shared/src/markdown/plugins.ts) with `data-copy-action`.
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest<HTMLElement>("[data-copy-action]");
      if (!btn) return;
      const block = btn.closest<HTMLElement>(".code-block");
      const code = block?.querySelector<HTMLElement>("pre > code");
      if (!code) return;
      void navigator.clipboard.writeText(code.textContent ?? "");
      const original = btn.textContent;
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("copied");
      }, 1200);
    };
    container.addEventListener("click", onClick);
    return () => container.removeEventListener("click", onClick);
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

  /* Inline code (between single backticks). The `.code-block` wrapper
     resets these — see below. */
  :global(.markdown code) {
    font-family: var(--font-mono);
    font-size: 0.8em;
    padding: 0.1rem 0.3rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm, 4px);
  }

  /* Fenced code block — chrome (lang chip + copy button) plus the pre/code
     body. Emitted by codeChromeExtension in @friday/shared/markdown. */
  :global(.markdown .code-block) {
    margin: 0.5rem 0;
    background: var(--bg-code, var(--bg-secondary));
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  :global(.markdown .code-block .code-header) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.3rem 0.6rem;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-subtle);
    font-family: var(--font-mono);
    font-size: 0.7rem;
  }
  :global(.markdown .code-block .code-lang) {
    color: var(--text-secondary);
    text-transform: lowercase;
    letter-spacing: 0.02em;
  }
  :global(.markdown .code-block .code-lang.code-lang-empty) {
    visibility: hidden;
  }
  :global(.markdown .code-block .code-copy) {
    appearance: none;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-secondary);
    font: inherit;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm, 4px);
    cursor: pointer;
    transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
  }
  :global(.markdown .code-block .code-copy:hover) {
    color: var(--text-primary);
    border-color: var(--border-subtle);
    background: var(--bg-secondary);
  }
  :global(.markdown .code-block .code-copy.copied) {
    color: var(--accent-primary);
    border-color: var(--accent-muted);
  }
  /* Touch devices need ≥44×44 tap targets (mobile-ux spec). Bump the
     button + header padding without changing the desktop look. */
  @media (pointer: coarse) {
    :global(.markdown .code-block .code-header) {
      padding: 0.35rem 0.6rem;
    }
    :global(.markdown .code-block .code-copy) {
      min-height: 44px;
      min-width: 44px;
      padding: 0.5rem 0.85rem;
    }
  }
  /* The body of the chrome — horizontal scroll, no wrap, per spec. */
  :global(.markdown .code-block pre) {
    margin: 0;
    padding: 0.75rem;
    background: transparent;
    border: none;
    border-radius: 0;
    overflow-x: auto;
    white-space: pre;
    word-wrap: normal;
  }
  :global(.markdown .code-block pre > code) {
    display: block;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 0;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    line-height: 1.5;
    white-space: pre;
    color: var(--text-primary);
  }
  /* Shiki dual-theme: every token span carries both --shiki-light and
     --shiki-dark CSS variables (via defaultColor:false). We pick which
     one to use based on the dashboard theme attribute on <html>. No
     re-highlight is needed on theme toggle. */
  :global(.markdown .code-block pre > code span) {
    color: var(--shiki-light);
  }
  :global(.dark .markdown .code-block pre > code span) {
    color: var(--shiki-dark);
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

  /* KaTeX overflow guard: wide formulas scroll inside the bubble instead of
     pushing the page sideways on narrow viewports. */
  :global(.markdown .katex-display) {
    overflow-x: auto;
    overflow-y: hidden;
    max-width: 100%;
    -webkit-overflow-scrolling: touch;
  }
  :global(.markdown .katex-display > .katex) {
    white-space: nowrap;
    max-width: none;
  }
  :global(.markdown .katex) {
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    vertical-align: middle;
  }
</style>
