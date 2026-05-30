import { afterEach, describe, expect, it } from "vitest";
import type { Component } from "svelte";
import {
  resolveToolRenderer,
  TOOL_RENDERERS,
  type ToolRenderer,
  type ToolRendererProps,
} from "./tool-renderers";

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
    // FRI-130 shipped this map empty; FRI-133 (renderer A) registers the
    // first real entry on the literal built-in key "TodoWrite".
    expect(Object.keys(TOOL_RENDERERS)).toEqual(["TodoWrite"]);
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
