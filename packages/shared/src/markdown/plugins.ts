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

  if (opts.mermaid !== false) {
    exts.push(mermaidCodeBlockExtension());
  }

  return exts;
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
