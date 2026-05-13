/**
 * Plugin registry for the markdown rendering pipeline.
 *
 * KaTeX inline math (`$x$`) + display math (`$$x$$`) renders via
 * `marked-katex-extension`. Mermaid diagrams render via a marker code-block
 * (`mermaid` lang) that the dashboard component dynamic-imports the
 * `mermaid` runtime to mount into.
 *
 * Shiki for syntax highlighting lives in the dashboard layer (heavier and
 * grammar-lazy-loaded there); this module only handles the grammar-agnostic
 * extensions that ship with shared.
 */

import type { MarkedExtension, Tokens } from "marked";
import markedKatex from "marked-katex-extension";

export interface MarkdownPluginOptions {
  /** Default true. Set false to skip KaTeX registration. */
  katex?: boolean;
  /** Default true. Set false to leave `mermaid` code blocks as plain code. */
  mermaid?: boolean;
}

/**
 * Returns the list of `marked` extensions to install for the given options.
 * Caller must `marked.use(...exts)` exactly once.
 */
export function getMarkedExtensions(
  opts: MarkdownPluginOptions = {},
): MarkedExtension[] {
  const exts: MarkedExtension[] = [];

  if (opts.katex !== false) {
    exts.push(markedKatex({ throwOnError: false }));
  }

  // Order matters: marked calls renderer overrides last-registered-first
  // with fall-through on `false`. Chrome is registered before mermaid so
  // mermaid is checked first; on non-mermaid langs it returns false and
  // chrome takes over.
  exts.push(codeChromeExtension());

  if (opts.mermaid !== false) {
    exts.push(mermaidCodeBlockExtension());
  }

  return exts;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Wraps every non-mermaid fenced code block in chrome — a header with
 * the language label and a Copy button, plus the `<pre><code>` body that
 * the dashboard's shiki pass later highlights into.
 *
 * The Copy button has no inline handler (DOMPurify would strip it and
 * inline JS is bad form anyway); it's marked with `data-copy-action` so
 * a single delegated click listener in `Markdown.svelte` can handle every
 * code block in the document.
 */
function codeChromeExtension(): MarkedExtension {
  return {
    renderer: {
      code(token: Tokens.Code) {
        const lang = (token.lang ?? "").trim();
        const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
        const langLabel = lang
          ? `<span class="code-lang">${escapeHtml(lang)}</span>`
          : `<span class="code-lang code-lang-empty" aria-hidden="true"></span>`;
        const body = `<pre><code${langClass}>${escapeHtml(token.text)}</code></pre>`;
        return (
          `<div class="code-block">` +
          `<div class="code-header">` +
          langLabel +
          `<button type="button" class="code-copy" data-copy-action aria-label="Copy code">Copy</button>` +
          `</div>` +
          body +
          `</div>`
        );
      },
    },
  };
}

/**
 * Marked renderer override that emits `<pre class="mermaid">` for ` ```mermaid `
 * fenced blocks. The dashboard's Markdown component mounts the actual
 * mermaid render via dynamic import on the resulting elements; this module
 * stays grammar-agnostic and dependency-light.
 */
function mermaidCodeBlockExtension(): MarkedExtension {
  return {
    renderer: {
      code(token: Tokens.Code) {
        if (token.lang !== "mermaid") return false;
        const escaped = token.text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return `<pre class="mermaid">${escaped}</pre>`;
      },
    },
  };
}
