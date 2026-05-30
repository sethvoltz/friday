import { afterEach, describe, expect, it } from "vitest";
import type { Component } from "svelte";
import {
  resolveToolRenderer,
  TOOL_RENDERERS,
  type ToolRenderer,
  type ToolRendererProps,
} from "./tool-renderers";
import FileEditRenderer from "./FileEditRenderer.svelte";

// Sentinel renderers. We assert *identity* of the resolved object, never a
// mount — mounting a real `.svelte` component would need the vite-svelte
// plugin + a DOM, neither of which the dashboard's node test pool provides.
// A plain object cast to the component type is sufficient to prove dispatch.
const todoStub: ToolRenderer = {
  component: { __sentinel: "todo" } as unknown as Component<ToolRendererProps>,
};
const mailStub: ToolRenderer = {
  component: { __sentinel: "mail" } as unknown as Component<ToolRendererProps>,
};

// Keep the shared mutable map clean between tests.
const originalKeys = Object.keys(TOOL_RENDERERS);
afterEach(() => {
  for (const k of Object.keys(TOOL_RENDERERS)) {
    if (!originalKeys.includes(k)) delete TOOL_RENDERERS[k];
  }
});

describe("resolveToolRenderer", () => {
  it("returns undefined for an unregistered tool name", () => {
    expect(resolveToolRenderer("ZZZ_unregistered")).toBe(undefined);
  });

  it("ships the TodoWrite renderer registered by default (FRI-133)", () => {
    // FRI-130 shipped this map empty; FRI-133 (renderer A) registers an entry
    // on the literal built-in key "TodoWrite". After FRI-134 (ticket B) the
    // registry also carries the file-edit family, so assert membership of the
    // TodoWrite key rather than the whole key set.
    expect(originalKeys).toContain("TodoWrite");
  });

  it("registers exactly the renderer tickets' keys by default (FRI-133 + FRI-134)", () => {
    // FRI-130 shipped the registry empty; FRI-133 (renderer A) adds TodoWrite
    // and FRI-134 (ticket B) adds the file-edit family. With both renderer
    // tickets landed, these five are the complete default key set.
    expect(new Set(originalKeys)).toEqual(
      new Set(["TodoWrite", "Write", "Edit", "MultiEdit", "NotebookEdit"]),
    );
  });

  it("resolves a built-in tool by its literal name once registered", () => {
    TOOL_RENDERERS["ExampleTool"] = todoStub;
    expect(resolveToolRenderer("ExampleTool")).toBe(todoStub);
  });

  it("does not resolve an unregistered built-in (Read)", () => {
    expect(resolveToolRenderer("Read")).toBe(undefined);
  });

  it("maps a friday MCP tool to its short-segment key regardless of <server>", () => {
    TOOL_RENDERERS["mail_send"] = mailStub;
    // The variable `<server>` segment must not affect the key: both resolve
    // to the same short-key stub.
    expect(resolveToolRenderer("mcp__friday-mail__mail_send")).toBe(mailStub);
    expect(resolveToolRenderer("mcp__friday-anything__mail_send")).toBe(mailStub);
  });

  it("does not false-positive an unregistered MCP short (mail_inbox)", () => {
    TOOL_RENDERERS["mail_send"] = mailStub;
    expect(resolveToolRenderer("mcp__friday-mail__mail_inbox")).toBe(undefined);
  });

  it("prefers a literal raw-name registration over the MCP short segment", () => {
    // A raw name that is itself MCP-shaped resolves to its raw-name entry
    // first (raw-name-first precedence).
    TOOL_RENDERERS["mcp__friday-mail__mail_send"] = todoStub;
    TOOL_RENDERERS["mail_send"] = mailStub;
    expect(resolveToolRenderer("mcp__friday-mail__mail_send")).toBe(todoStub);
  });
});

describe("file-edit renderer registration (FRI-134 AC#2)", () => {
  it("resolves all four file-edit tools to the SAME FileEditRenderer entry", () => {
    const write = resolveToolRenderer("Write");
    const edit = resolveToolRenderer("Edit");
    const multi = resolveToolRenderer("MultiEdit");
    const notebook = resolveToolRenderer("NotebookEdit");

    // Object identity — one shared ToolRenderer instance backs all four keys.
    expect(write).toBeDefined();
    expect(edit).toBe(write);
    expect(multi).toBe(write);
    expect(notebook).toBe(write);

    // The component is the real FileEditRenderer (not a stub, not ToolBlock).
    expect(write!.component).toBe(FileEditRenderer);
    // Marked shown-directly.
    expect(write!.direct).toBe(true);
  });

  it("leaves Read on the generic ToolBlock (no renderer registered)", () => {
    expect(resolveToolRenderer("Read")).toBe(undefined);
  });
});
