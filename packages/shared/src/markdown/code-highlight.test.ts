// @vitest-environment jsdom

/**
 * Tests for the streamed code-block highlight gate.
 *
 * Mirrors the shape of streaming-mermaid: a DOM-mutation helper that
 * walks unhighlighted `<pre><code class="language-…">` blocks inside a
 * container, defers the *trailing* block while the bubble is still
 * streaming (so we don't pay the syntax-highlight cost for a fence whose
 * body is still growing), and delegates the actual token-span emission
 * to an injected `highlight(text, lang)` function. Real wiring in the
 * dashboard hands that to shiki; tests stub it with vi.fn() so the
 * assertions stay focused on the gate logic.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyCodeHighlight } from "./code-highlight";

function makeContainer(html: string): HTMLDivElement {
  document.body.innerHTML = "";
  const c = document.createElement("div");
  c.innerHTML = html;
  document.body.appendChild(c);
  return c;
}

let highlightMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  highlightMock = vi.fn();
});

describe("applyCodeHighlight", () => {
  it("returns 0 and never calls highlight when the container has no code blocks", async () => {
    const container = makeContainer(`<p>just prose</p>`);
    const count = await applyCodeHighlight(container, {
      streaming: false,
      highlight: highlightMock,
    });
    expect(count).toBe(0);
    expect(highlightMock).not.toHaveBeenCalled();
  });

  it("returns 0 when code has no language class (nothing to highlight)", async () => {
    const container = makeContainer(`<pre><code>plain text</code></pre>`);
    const count = await applyCodeHighlight(container, {
      streaming: false,
      highlight: highlightMock,
    });
    expect(count).toBe(0);
    expect(highlightMock).not.toHaveBeenCalled();
  });

  it("non-streaming + single block: highlights and stamps data-shiki-rendered", async () => {
    highlightMock.mockResolvedValue(`<span>token spans</span>`);
    const container = makeContainer(
      `<pre><code class="language-ts">const x = 1</code></pre>`,
    );
    const code = container.querySelector<HTMLElement>("code")!;
    const count = await applyCodeHighlight(container, {
      streaming: false,
      highlight: highlightMock,
    });
    expect(count).toBe(1);
    expect(highlightMock).toHaveBeenCalledTimes(1);
    expect(highlightMock).toHaveBeenCalledWith("const x = 1", "ts");
    expect(code.innerHTML).toBe(`<span>token spans</span>`);
    expect(code.getAttribute("data-shiki-rendered")).toBe("true");
  });

  it("streaming + single (trailing) block: skipped, plain text preserved", async () => {
    const container = makeContainer(
      `<pre><code class="language-ts">const x =</code></pre>`,
    );
    const code = container.querySelector<HTMLElement>("code")!;
    const count = await applyCodeHighlight(container, {
      streaming: true,
      highlight: highlightMock,
    });
    expect(count).toBe(0);
    expect(highlightMock).not.toHaveBeenCalled();
    expect(code.textContent).toBe("const x =");
    expect(code.hasAttribute("data-shiki-rendered")).toBe(false);
  });

  it("streaming + two blocks: first highlighted, second (trailing) skipped", async () => {
    highlightMock.mockResolvedValue(`<span>spans</span>`);
    const container = makeContainer(`
      <pre><code class="language-ts">const a = 1</code></pre>
      <p>middle prose</p>
      <pre><code class="language-py">def foo</code></pre>
    `);
    const codes = Array.from(
      container.querySelectorAll<HTMLElement>("pre > code"),
    );
    const count = await applyCodeHighlight(container, {
      streaming: true,
      highlight: highlightMock,
    });
    expect(count).toBe(1);
    expect(highlightMock).toHaveBeenCalledTimes(1);
    expect(highlightMock).toHaveBeenCalledWith("const a = 1", "ts");
    expect(codes[0].getAttribute("data-shiki-rendered")).toBe("true");
    expect(codes[1].hasAttribute("data-shiki-rendered")).toBe(false);
    expect(codes[1].textContent).toBe("def foo");
  });

  it("non-streaming + multiple blocks: all highlighted", async () => {
    highlightMock.mockImplementation(async (text: string) => `<x>${text}</x>`);
    const container = makeContainer(`
      <pre><code class="language-ts">A</code></pre>
      <pre><code class="language-py">B</code></pre>
    `);
    const count = await applyCodeHighlight(container, {
      streaming: false,
      highlight: highlightMock,
    });
    expect(count).toBe(2);
    expect(highlightMock).toHaveBeenCalledTimes(2);
  });

  it("skips already-rendered blocks (idempotency / re-entry safety)", async () => {
    highlightMock.mockResolvedValue(`<span>fresh</span>`);
    const container = makeContainer(`
      <pre><code class="language-ts" data-shiki-rendered="true"><span>old</span></code></pre>
      <pre><code class="language-py">B</code></pre>
    `);
    const codes = Array.from(
      container.querySelectorAll<HTMLElement>("pre > code"),
    );
    const count = await applyCodeHighlight(container, {
      streaming: false,
      highlight: highlightMock,
    });
    expect(count).toBe(1);
    expect(highlightMock).toHaveBeenCalledTimes(1);
    expect(highlightMock).toHaveBeenCalledWith("B", "py");
    // Old rendered block left untouched.
    expect(codes[0].innerHTML).toBe(`<span>old</span>`);
  });

  it("skips language-mermaid even if a stray <code class=\"language-mermaid\"> sneaks in", async () => {
    const container = makeContainer(
      `<pre><code class="language-mermaid">graph TD; A-->B</code></pre>`,
    );
    const count = await applyCodeHighlight(container, {
      streaming: false,
      highlight: highlightMock,
    });
    expect(count).toBe(0);
    expect(highlightMock).not.toHaveBeenCalled();
  });

  it("if highlight throws, leaves the block alone (defensive)", async () => {
    highlightMock.mockRejectedValue(new Error("no grammar"));
    const container = makeContainer(
      `<pre><code class="language-xx">whatever</code></pre>`,
    );
    const code = container.querySelector<HTMLElement>("code")!;
    const count = await applyCodeHighlight(container, {
      streaming: false,
      highlight: highlightMock,
    });
    expect(count).toBe(0);
    expect(code.textContent).toBe("whatever");
    expect(code.hasAttribute("data-shiki-rendered")).toBe(false);
  });

  it("if highlight returns empty string, leaves the block alone", async () => {
    highlightMock.mockResolvedValue("");
    const container = makeContainer(
      `<pre><code class="language-xx">whatever</code></pre>`,
    );
    const code = container.querySelector<HTMLElement>("code")!;
    const count = await applyCodeHighlight(container, {
      streaming: false,
      highlight: highlightMock,
    });
    expect(count).toBe(0);
    expect(code.textContent).toBe("whatever");
    expect(code.hasAttribute("data-shiki-rendered")).toBe(false);
  });

  it("trailing-ness is among pre > code siblings, not absolute last child", async () => {
    highlightMock.mockResolvedValue(`<span>spans</span>`);
    const container = makeContainer(`
      <pre><code class="language-ts">first</code></pre>
      <p>text</p>
      <pre><code class="language-py">second</code></pre>
      <p>more</p>
    `);
    const codes = Array.from(
      container.querySelectorAll<HTMLElement>("pre > code"),
    );
    const count = await applyCodeHighlight(container, {
      streaming: true,
      highlight: highlightMock,
    });
    expect(count).toBe(1);
    expect(highlightMock).toHaveBeenCalledWith("first", "ts");
    expect(codes[1].hasAttribute("data-shiki-rendered")).toBe(false);
  });

  it("idempotent: second call is a no-op when nothing has changed", async () => {
    highlightMock.mockResolvedValue(`<span>x</span>`);
    const container = makeContainer(
      `<pre><code class="language-ts">A</code></pre>`,
    );
    const first = await applyCodeHighlight(container, {
      streaming: false,
      highlight: highlightMock,
    });
    const second = await applyCodeHighlight(container, {
      streaming: false,
      highlight: highlightMock,
    });
    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(highlightMock).toHaveBeenCalledTimes(1);
  });
});
