/**
 * Plugin registry for the markdown rendering pipeline. v1 ships with Shiki
 * via the dashboard; KaTeX/Mermaid plugins drop in here in v2.
 *
 * The plugin shape is deliberately minimal — extensions are configured at the
 * dashboard layer where `marked` lives. This module is the contract.
 */

export interface MarkdownPlugin {
  name: string;
  /** Optional: marked extensions to register. */
  marked?: unknown[];
  /** Optional: post-render DOM transforms (run on the parsed HTML string). */
  transform?: (html: string) => string;
}

export const builtinPlugins: MarkdownPlugin[] = [];

/** v2 hook — KaTeX plugin slot. */
export function katexPlugin(): MarkdownPlugin {
  throw new Error("KaTeX plugin not yet implemented");
}

/** v2 hook — Mermaid plugin slot. */
export function mermaidPlugin(): MarkdownPlugin {
  throw new Error("Mermaid plugin not yet implemented");
}
