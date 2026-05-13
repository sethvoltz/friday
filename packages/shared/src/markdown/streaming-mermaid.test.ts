// @vitest-environment jsdom

/**
 * Tests for the streaming-mermaid render gate.
 *
 * The helper sits between marked's emitted `<pre class="mermaid">` blocks and
 * the actual mermaid library `run()` call. Its job is to decide which blocks
 * are safe to render right now ("render") and which should stay as a
 * placeholder ("pending") because either (a) the bubble is still streaming
 * and this is the last mermaid block (so more chars may arrive) or (b) the
 * mermaid parser says the current text is not yet syntactically valid.
 *
 * These tests are deliberately stateful — they build real DOM in jsdom, run
 * the helper, and assert on the resulting DOM mutations and the recorded
 * library calls. Per the testing-discipline notes in the global CLAUDE.md,
 * the bug here lives in the wiring (which selector, which order, what
 * happens on re-entry), not in any single pure decision — so the assertions
 * are about observable behavior.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyStreamingMermaidGate,
  invalidateRenderedMermaid,
} from "./streaming-mermaid";

function makeContainer(html: string): HTMLDivElement {
  // Reset between tests.
  document.body.innerHTML = "";
  const c = document.createElement("div");
  c.innerHTML = html;
  document.body.appendChild(c);
  return c;
}

let parseMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  parseMock = vi.fn();
});

describe("applyStreamingMermaidGate", () => {
  it("returns [] and never calls parse when the container has no mermaid blocks", async () => {
    const container = makeContainer(`<p>just prose</p>`);
    const result = await applyStreamingMermaidGate(container, {
      streaming: false,
      parse: parseMock,
    });
    expect(result).toEqual([]);
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("non-streaming + single valid block: returns the node, parsed, no pending attr", async () => {
    parseMock.mockResolvedValue({ diagramType: "flowchart" });
    const container = makeContainer(
      `<pre class="mermaid">graph TD\n  A --> B</pre>`,
    );
    const node = container.querySelector("pre.mermaid")!;
    const result = await applyStreamingMermaidGate(container, {
      streaming: false,
      parse: parseMock,
    });
    expect(result).toEqual([node]);
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(parseMock).toHaveBeenCalledWith("graph TD\n  A --> B");
    expect(node.hasAttribute("data-mermaid-pending")).toBe(false);
  });

  it("streaming + single block (which is trailing): pending, parse not called", async () => {
    const container = makeContainer(
      `<pre class="mermaid">graph TD\n  A --></pre>`,
    );
    const node = container.querySelector("pre.mermaid")!;
    const result = await applyStreamingMermaidGate(container, {
      streaming: true,
      parse: parseMock,
    });
    expect(result).toEqual([]);
    expect(parseMock).not.toHaveBeenCalled();
    expect(node.getAttribute("data-mermaid-pending")).toBe("true");
  });

  it("streaming + two mermaid blocks: first renders, second (trailing) is pending", async () => {
    parseMock.mockResolvedValue({ diagramType: "flowchart" });
    const container = makeContainer(`
      <pre class="mermaid">graph TD\n  A --> B</pre>
      <p>middle prose</p>
      <pre class="mermaid">graph TD\n  C</pre>
    `);
    const [first, second] = Array.from(
      container.querySelectorAll<HTMLElement>("pre.mermaid"),
    );
    const result = await applyStreamingMermaidGate(container, {
      streaming: true,
      parse: parseMock,
    });
    expect(result).toEqual([first]);
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(parseMock).toHaveBeenCalledWith("graph TD\n  A --> B");
    expect(first.hasAttribute("data-mermaid-pending")).toBe(false);
    expect(second.getAttribute("data-mermaid-pending")).toBe("true");
  });

  it("non-streaming + two valid blocks: both parsed, both returned", async () => {
    parseMock.mockResolvedValue({ diagramType: "flowchart" });
    const container = makeContainer(`
      <pre class="mermaid">graph TD\n  A --> B</pre>
      <pre class="mermaid">graph TD\n  C --> D</pre>
    `);
    const all = Array.from(
      container.querySelectorAll<HTMLElement>("pre.mermaid"),
    );
    const result = await applyStreamingMermaidGate(container, {
      streaming: false,
      parse: parseMock,
    });
    expect(result).toEqual(all);
    expect(parseMock).toHaveBeenCalledTimes(2);
  });

  it("non-streaming + parse returns false: pending, not returned", async () => {
    parseMock.mockResolvedValue(false);
    const container = makeContainer(
      `<pre class="mermaid">not a real diagram</pre>`,
    );
    const node = container.querySelector("pre.mermaid")!;
    const result = await applyStreamingMermaidGate(container, {
      streaming: false,
      parse: parseMock,
    });
    expect(result).toEqual([]);
    expect(node.getAttribute("data-mermaid-pending")).toBe("true");
  });

  it("non-streaming + parse rejects: defensive-catch makes node pending", async () => {
    parseMock.mockRejectedValue(new Error("boom"));
    const container = makeContainer(
      `<pre class="mermaid">graph TD\n  ???</pre>`,
    );
    const node = container.querySelector("pre.mermaid")!;
    const result = await applyStreamingMermaidGate(container, {
      streaming: false,
      parse: parseMock,
    });
    expect(result).toEqual([]);
    expect(node.getAttribute("data-mermaid-pending")).toBe("true");
  });

  it("re-entry promotes a previously-pending block once its parse becomes valid", async () => {
    const container = makeContainer(
      `<pre class="mermaid">graph TD\n  A --</pre>`,
    );
    const node = container.querySelector<HTMLElement>("pre.mermaid")!;

    parseMock.mockResolvedValueOnce(false);
    const r1 = await applyStreamingMermaidGate(container, {
      streaming: false,
      parse: parseMock,
    });
    expect(r1).toEqual([]);
    expect(node.getAttribute("data-mermaid-pending")).toBe("true");

    // Simulate more chars arriving and completing the diagram.
    node.textContent = "graph TD\n  A --> B";
    parseMock.mockResolvedValueOnce({ diagramType: "flowchart" });
    const r2 = await applyStreamingMermaidGate(container, {
      streaming: false,
      parse: parseMock,
    });
    expect(r2).toEqual([node]);
    expect(node.hasAttribute("data-mermaid-pending")).toBe(false);
    expect(node.getAttribute("data-mermaid-rendered")).toBe("true");
  });

  it("skips already-rendered nodes and never passes them to parse", async () => {
    parseMock.mockResolvedValue({ diagramType: "flowchart" });
    const container = makeContainer(`
      <pre class="mermaid" data-mermaid-rendered="true">already-mounted body</pre>
      <pre class="mermaid">graph TD\n  X --> Y</pre>
    `);
    const fresh = Array.from(
      container.querySelectorAll<HTMLElement>("pre.mermaid"),
    )[1];
    const result = await applyStreamingMermaidGate(container, {
      streaming: false,
      parse: parseMock,
    });
    expect(result).toEqual([fresh]);
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(parseMock).toHaveBeenCalledWith("graph TD\n  X --> Y");
  });

  it("marks returned nodes data-mermaid-rendered before returning them", async () => {
    parseMock.mockResolvedValue({ diagramType: "flowchart" });
    const container = makeContainer(
      `<pre class="mermaid">graph TD\n  A --> B</pre>`,
    );
    const node = container.querySelector<HTMLElement>("pre.mermaid")!;
    const result = await applyStreamingMermaidGate(container, {
      streaming: false,
      parse: parseMock,
    });
    expect(result).toEqual([node]);
    expect(node.getAttribute("data-mermaid-rendered")).toBe("true");
  });

  it("is idempotent: second call returns [] and does not re-parse rendered nodes", async () => {
    parseMock.mockResolvedValue({ diagramType: "flowchart" });
    const container = makeContainer(
      `<pre class="mermaid">graph TD\n  A --> B</pre>`,
    );
    const node = container.querySelector<HTMLElement>("pre.mermaid")!;
    const first = await applyStreamingMermaidGate(container, {
      streaming: false,
      parse: parseMock,
    });
    const second = await applyStreamingMermaidGate(container, {
      streaming: false,
      parse: parseMock,
    });
    expect(first).toEqual([node]);
    expect(second).toEqual([]);
    expect(parseMock).toHaveBeenCalledTimes(1);
  });

  it("trailing-ness is defined among pre.mermaid siblings, not absolute last child", async () => {
    // B is the last mermaid block even though more prose comes after it.
    parseMock.mockResolvedValue({ diagramType: "flowchart" });
    const container = makeContainer(`
      <pre class="mermaid">A-body</pre>
      <p>text</p>
      <pre class="mermaid">B-body</pre>
      <p>more</p>
    `);
    const [first, second] = Array.from(
      container.querySelectorAll<HTMLElement>("pre.mermaid"),
    );
    const result = await applyStreamingMermaidGate(container, {
      streaming: true,
      parse: parseMock,
    });
    expect(result).toEqual([first]);
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(parseMock).toHaveBeenCalledWith("A-body");
    expect(second.getAttribute("data-mermaid-pending")).toBe("true");
  });

  it("snapshots source text into data-mermaid-source on returned nodes (so theme re-render can restore it)", async () => {
    parseMock.mockResolvedValue({ diagramType: "flowchart" });
    const container = makeContainer(
      `<pre class="mermaid">graph TD\n  A --> B</pre>`,
    );
    const node = container.querySelector<HTMLElement>("pre.mermaid")!;
    await applyStreamingMermaidGate(container, {
      streaming: false,
      parse: parseMock,
    });
    expect(node.getAttribute("data-mermaid-source")).toBe("graph TD\n  A --> B");
  });

  it("does NOT snapshot source on pending nodes (no value to restore, and re-entry rewrites textContent only on completion)", async () => {
    parseMock.mockResolvedValue(false);
    const container = makeContainer(
      `<pre class="mermaid">graph TD\n  partial</pre>`,
    );
    const node = container.querySelector<HTMLElement>("pre.mermaid")!;
    await applyStreamingMermaidGate(container, {
      streaming: false,
      parse: parseMock,
    });
    expect(node.hasAttribute("data-mermaid-source")).toBe(false);
  });
});

describe("invalidateRenderedMermaid", () => {
  it("does nothing when there are no rendered mermaid blocks", () => {
    const container = makeContainer(`<p>prose only</p>`);
    const count = invalidateRenderedMermaid(container);
    expect(count).toBe(0);
  });

  it("restores textContent from data-mermaid-source and clears data-mermaid-rendered", () => {
    // Simulate what the DOM looks like after mermaid has replaced the
    // pre's contents with an SVG.
    const container = makeContainer(
      `<pre class="mermaid" data-mermaid-rendered="true" data-mermaid-source="graph TD\n  A --> B"><svg><g>fake rendered</g></svg></pre>`,
    );
    const node = container.querySelector<HTMLElement>("pre.mermaid")!;
    const count = invalidateRenderedMermaid(container);
    expect(count).toBe(1);
    expect(node.textContent).toBe("graph TD\n  A --> B");
    expect(node.hasAttribute("data-mermaid-rendered")).toBe(false);
    // Source snapshot is preserved so a subsequent invalidation (after
    // another render) still has something to restore.
    expect(node.getAttribute("data-mermaid-source")).toBe("graph TD\n  A --> B");
  });

  it("skips rendered nodes that have no data-mermaid-source (defensive — can't restore what we don't have)", () => {
    const container = makeContainer(
      `<pre class="mermaid" data-mermaid-rendered="true"><svg/></pre>`,
    );
    const node = container.querySelector<HTMLElement>("pre.mermaid")!;
    const count = invalidateRenderedMermaid(container);
    expect(count).toBe(0);
    // Leave it alone — the rendered flag stays so we don't trigger a
    // broken re-render against the wrong text.
    expect(node.getAttribute("data-mermaid-rendered")).toBe("true");
  });

  it("invalidates multiple rendered blocks in one pass and ignores pending/un-rendered ones", () => {
    const container = makeContainer(`
      <pre class="mermaid" data-mermaid-rendered="true" data-mermaid-source="A-src"><svg/></pre>
      <pre class="mermaid" data-mermaid-pending="true">B-pending</pre>
      <pre class="mermaid" data-mermaid-rendered="true" data-mermaid-source="C-src"><svg/></pre>
    `);
    const all = Array.from(
      container.querySelectorAll<HTMLElement>("pre.mermaid"),
    );
    const count = invalidateRenderedMermaid(container);
    expect(count).toBe(2);
    expect(all[0].textContent).toBe("A-src");
    expect(all[0].hasAttribute("data-mermaid-rendered")).toBe(false);
    expect(all[1].getAttribute("data-mermaid-pending")).toBe("true");
    expect(all[1].textContent).toBe("B-pending");
    expect(all[2].textContent).toBe("C-src");
    expect(all[2].hasAttribute("data-mermaid-rendered")).toBe(false);
  });

  it("also clears mermaid's own data-processed flag so a subsequent mermaid.run actually re-renders", () => {
    // Regression: mermaid v11 sets data-processed="true" on rendered
    // <pre> elements and skips them on the next run() call. If we don't
    // clear that flag, theme-swap re-renders silently no-op and the
    // diagram stays as plain restored text.
    const container = makeContainer(
      `<pre class="mermaid" data-mermaid-rendered="true" data-mermaid-source="graph TD\n  A --> B" data-processed="true"><svg/></pre>`,
    );
    const node = container.querySelector<HTMLElement>("pre.mermaid")!;
    expect(invalidateRenderedMermaid(container)).toBe(1);
    expect(node.hasAttribute("data-processed")).toBe(false);
  });

  it("round-trip: invalidate-then-gate re-promotes the same node back to rendered", async () => {
    parseMock.mockResolvedValue({ diagramType: "flowchart" });
    const container = makeContainer(
      `<pre class="mermaid">graph TD\n  A --> B</pre>`,
    );
    const node = container.querySelector<HTMLElement>("pre.mermaid")!;

    // First render — sets rendered + source snapshot.
    await applyStreamingMermaidGate(container, {
      streaming: false,
      parse: parseMock,
    });
    expect(node.getAttribute("data-mermaid-rendered")).toBe("true");
    expect(node.getAttribute("data-mermaid-source")).toBe("graph TD\n  A --> B");

    // Simulate mermaid having replaced the body with an SVG.
    node.innerHTML = "<svg><g>fake</g></svg>";

    // Theme toggle → invalidate. Source restored, rendered flag cleared.
    expect(invalidateRenderedMermaid(container)).toBe(1);
    expect(node.textContent).toBe("graph TD\n  A --> B");
    expect(node.hasAttribute("data-mermaid-rendered")).toBe(false);

    // Re-running the gate should re-promote it.
    const result = await applyStreamingMermaidGate(container, {
      streaming: false,
      parse: parseMock,
    });
    expect(result).toEqual([node]);
    expect(node.getAttribute("data-mermaid-rendered")).toBe("true");
    expect(parseMock).toHaveBeenCalledTimes(2);
  });
});
