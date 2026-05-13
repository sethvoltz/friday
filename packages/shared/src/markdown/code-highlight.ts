/**
 * Render gate for streamed fenced code blocks.
 *
 * Marked emits `<pre><code class="language-…">…raw text…</code></pre>` for
 * every fenced block. Re-running shiki (or any token-by-token highlighter)
 * against the *trailing* block on every SSE delta would thrash colors as
 * the body grows. This helper picks the right blocks to highlight now and
 * leaves the trailing-of-a-streaming-bubble one as plain monospaced text
 * until either the next delta makes it non-trailing (its closing fence
 * has arrived) or the bubble flips to `complete`.
 *
 * Decisions per `pre > code[class*="language-…"]` block, in order:
 *   1. Already highlighted (`data-shiki-rendered`) → skip silently.
 *   2. Class is `language-mermaid` → skip (mermaid takes a separate path).
 *   3. `streaming` AND this is the last `<code>` in the container → skip
 *      (raw text is the right intermediate state).
 *   4. Otherwise → `await highlight(text, lang)`. Empty result or thrown
 *      error → leave the block alone (so unsupported grammars keep the
 *      raw fenced text rather than disappear). Non-empty result → swap
 *      into innerHTML and stamp `data-shiki-rendered`.
 *
 * Theme switching is intentionally NOT handled here. Shiki's dual-theme
 * mode emits spans with `--shiki-light` / `--shiki-dark` CSS variables;
 * downstream CSS picks between them based on `<html data-theme>`. No
 * re-highlight is required on theme toggle, so no source snapshot or
 * invalidate helper is needed (unlike mermaid, which bakes colors into
 * its SVG at render time).
 *
 * @returns the number of blocks that were highlighted on this pass.
 */

export interface CodeHighlightDeps {
  /** True while the bubble is still receiving SSE deltas. Mirrors
   *  ChatMessage.status === "streaming" in the dashboard. */
  streaming: boolean;
  /** Called with the raw source text and the parsed lang short-name
   *  (e.g. "ts" from "language-ts"). Should resolve to the inner HTML
   *  (token spans) to insert into the `<code>` element. Resolve to an
   *  empty string — or throw — to leave the block as plain text. */
  highlight: (text: string, lang: string) => Promise<string>;
}

const RENDERED_ATTR = "data-shiki-rendered";
const LANG_PREFIX = "language-";

function langFromClass(node: HTMLElement): string | null {
  for (const cls of node.classList) {
    if (cls.startsWith(LANG_PREFIX)) {
      const lang = cls.slice(LANG_PREFIX.length);
      return lang.length > 0 ? lang : null;
    }
  }
  return null;
}

export async function applyCodeHighlight(
  container: HTMLElement,
  deps: CodeHighlightDeps,
): Promise<number> {
  const all = Array.from(
    container.querySelectorAll<HTMLElement>("pre > code"),
  );
  if (all.length === 0) return 0;

  // Trailing is defined among `<pre> > <code>` siblings — interleaved
  // prose after the last code block doesn't make it "non-trailing".
  const lastCode = all[all.length - 1];

  let highlighted = 0;
  for (const node of all) {
    if (node.hasAttribute(RENDERED_ATTR)) continue;
    const lang = langFromClass(node);
    if (lang === null) continue;
    if (lang === "mermaid") continue;
    if (deps.streaming && node === lastCode) continue;

    let html: string;
    try {
      html = await deps.highlight(node.textContent ?? "", lang);
    } catch {
      continue;
    }
    if (!html) continue;

    node.innerHTML = html;
    node.setAttribute(RENDERED_ATTR, "true");
    highlighted++;
  }

  return highlighted;
}
