/**
 * Render gate for streamed mermaid diagrams.
 *
 * Marked's mermaid `renderer.code` override emits a `<pre class="mermaid">`
 * the moment it sees the opening fence — even when the body is partial
 * mid-stream. Calling `mermaid.run` on that partial body produces error
 * nodes that flash in and out until the closing fence arrives. This helper
 * is the choke point between marked's output and the actual mermaid render
 * call: it decides which blocks are safe to mount right now, and leaves the
 * others as placeholders that re-evaluate on the next pass.
 *
 * Decisions per `pre.mermaid` block, in order:
 *   1. Already mounted (data-mermaid-rendered) → skip silently.
 *   2. Streaming AND this block is the last `pre.mermaid` in the container
 *      → "pending" (more chars may still arrive). Marked with
 *      data-mermaid-pending="true". Parse is NOT called.
 *   3. Otherwise → await parse(text). Truthy ⇒ "render" (returned in the
 *      result array, marked data-mermaid-rendered=true so a re-entry skips
 *      it). Falsy or thrown ⇒ "pending" (marked data-mermaid-pending=true,
 *      not returned).
 *
 * Re-entry safety: pending nodes have their pending flag cleared at the
 * start of each call before being re-decided, so a node that was pending
 * because of mid-stream partial syntax can be promoted to rendered on a
 * later call once the closing fence has arrived.
 */

export interface MermaidGateDeps {
  /** True while the bubble is still receiving SSE deltas. Mirrors
   *  ChatMessage.status === "streaming" in the dashboard. */
  streaming: boolean;
  /** mermaid.parse-shaped probe. Should return a truthy value when the
   *  diagram is syntactically valid and `false` (or throw / reject) when
   *  it is not. The helper treats anything falsy as invalid. */
  parse: (text: string) => Promise<unknown>;
}

const PENDING_ATTR = "data-mermaid-pending";
const RENDERED_ATTR = "data-mermaid-rendered";
const SOURCE_ATTR = "data-mermaid-source";

export async function applyStreamingMermaidGate(
  container: HTMLElement,
  deps: MermaidGateDeps,
): Promise<HTMLElement[]> {
  const all = Array.from(
    container.querySelectorAll<HTMLElement>("pre.mermaid"),
  );
  const candidates = all.filter((n) => !n.hasAttribute(RENDERED_ATTR));
  if (candidates.length === 0) return [];

  // Clear stale pending flags so re-entry can re-decide a block that has
  // since become valid.
  for (const node of candidates) node.removeAttribute(PENDING_ATTR);

  const lastMermaid = all[all.length - 1];
  const toRender: HTMLElement[] = [];

  for (const node of candidates) {
    if (deps.streaming && node === lastMermaid) {
      node.setAttribute(PENDING_ATTR, "true");
      continue;
    }
    let ok: unknown = false;
    try {
      ok = await deps.parse(node.textContent ?? "");
    } catch {
      ok = false;
    }
    if (!ok) {
      node.setAttribute(PENDING_ATTR, "true");
      continue;
    }
    // Snapshot the source text BEFORE handing the node to mermaid.run,
    // which will replace textContent with the rendered SVG. Saving the
    // source here gives invalidateRenderedMermaid a way to restore it for
    // a clean re-render on theme switch.
    node.setAttribute(SOURCE_ATTR, node.textContent ?? "");
    node.setAttribute(RENDERED_ATTR, "true");
    toRender.push(node);
  }

  return toRender;
}

/**
 * Wipes the rendered SVG from every `pre.mermaid[data-mermaid-rendered]` in
 * `root` and restores the original mermaid source from its
 * `data-mermaid-source` snapshot, clearing the rendered flag so the next
 * pass of `applyStreamingMermaidGate` re-renders the diagram from scratch.
 *
 * Use this when the surrounding theme has changed — mermaid stamps theme
 * colors into the SVG at render time, so the only way to re-skin existing
 * diagrams is to render them again against the new theme.
 *
 * Defensive: rendered nodes that lack a source snapshot are skipped (we
 * have no original text to restore them to). Pending and never-rendered
 * nodes are left untouched.
 *
 * @returns the count of nodes that were actually invalidated.
 */
export function invalidateRenderedMermaid(root: ParentNode): number {
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>(`pre.mermaid[${RENDERED_ATTR}]`),
  );
  let invalidated = 0;
  for (const node of nodes) {
    const src = node.getAttribute(SOURCE_ATTR);
    if (src === null) continue;
    node.textContent = src;
    node.removeAttribute(RENDERED_ATTR);
    // Mermaid v11 stamps `data-processed="true"` on every rendered <pre>
    // and silently skips re-processing it. Without this clear, the next
    // mermaid.run() call no-ops and the user sees the restored mermaid
    // source as plain text instead of a re-themed diagram.
    node.removeAttribute("data-processed");
    invalidated++;
  }
  return invalidated;
}
