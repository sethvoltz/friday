import { afterEach, describe, expect, it } from "vitest";
import type { Component } from "svelte";
import {
  resolveToolRenderer,
  TOOL_RENDERERS,
  type ToolRenderer,
  type ToolRendererProps,
} from "./tool-renderers";
import FileEditRenderer from "./FileEditRenderer.svelte";
import MailToolBlock from "./MailToolBlock.svelte";
import ScheduleWakeupBlock from "./ScheduleWakeupBlock.svelte";

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

// Snapshot the registry's module-load state (TodoWrite from FRI-133, the
// file-edit family from FRI-134, and the four FRI-135 mail entries) so tests
// that mutate it can restore exactly — both newly-added keys AND overwritten
// pre-existing keys (e.g. a test that re-points `mail_send` at a stub must not
// leak that stub into the next test).
const originalEntries = { ...TOOL_RENDERERS };
const originalKeys = Object.keys(originalEntries);
afterEach(() => {
  for (const k of Object.keys(TOOL_RENDERERS)) {
    if (!originalKeys.includes(k)) delete TOOL_RENDERERS[k];
  }
  for (const k of originalKeys) {
    TOOL_RENDERERS[k] = originalEntries[k]!;
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

  it("registers exactly the renderer tickets' keys by default (FRI-133 + FRI-134 + FRI-135 + FRI-152 + ScheduleWakeup)", () => {
    // FRI-130 shipped the registry empty; FRI-133 (renderer A) adds TodoWrite,
    // FRI-134 (ticket B) adds the file-edit family, FRI-135 (ticket C) adds
    // the four friday-mail short names, FRI-152 adds AskUserQuestion, and the
    // ScheduleWakeup renderer adds "ScheduleWakeup". These eleven are the
    // complete default key set.
    expect(new Set(originalKeys)).toEqual(
      new Set([
        "TodoWrite",
        "Write",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
        "mail_send",
        "mail_inbox",
        "mail_read",
        "mail_close",
        "AskUserQuestion",
        "ask_user",
        "ScheduleWakeup",
      ]),
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
    TOOL_RENDERERS["agent_status"] = mailStub;
    // The variable `<server>` segment must not affect the key: both resolve
    // to the same short-key stub.
    expect(resolveToolRenderer("mcp__friday-agents__agent_status")).toBe(mailStub);
    expect(resolveToolRenderer("mcp__friday-anything__agent_status")).toBe(mailStub);
  });

  it("does not false-positive an unregistered MCP short", () => {
    TOOL_RENDERERS["agent_status"] = mailStub;
    expect(resolveToolRenderer("mcp__friday-agents__agent_inspect")).toBe(undefined);
  });

  it("prefers a literal raw-name registration over the MCP short segment", () => {
    // A raw name that is itself MCP-shaped resolves to its raw-name entry
    // first (raw-name-first precedence).
    TOOL_RENDERERS["mcp__friday-mail__mail_send"] = todoStub;
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

describe("friday-mail renderer registration (FRI-135)", () => {
  // AC3: all four `mcp__friday-mail__mail_*` names resolve to a defined
  // renderer whose `.component` is the SAME registered MailToolBlock
  // reference — proving one component fronts all four tools.
  it("resolves all four mail tools to the same MailToolBlock component", () => {
    const send = resolveToolRenderer("mcp__friday-mail__mail_send");
    const inbox = resolveToolRenderer("mcp__friday-mail__mail_inbox");
    const read = resolveToolRenderer("mcp__friday-mail__mail_read");
    const close = resolveToolRenderer("mcp__friday-mail__mail_close");

    expect(send).toBeDefined();
    expect(inbox).toBeDefined();
    expect(read).toBeDefined();
    expect(close).toBeDefined();

    expect(send!.component).toBe(MailToolBlock);
    expect(inbox!.component).toBe(MailToolBlock);
    expect(read!.component).toBe(MailToolBlock);
    expect(close!.component).toBe(MailToolBlock);

    // All four point at the SAME registered reference (one component, four
    // entries) — not four distinct components.
    expect(inbox!.component).toBe(send!.component);
    expect(read!.component).toBe(send!.component);
    expect(close!.component).toBe(send!.component);
  });

  // AC4: server-segment collapsing pinned by exact value — a different
  // `<server>` segment resolves to the SAME registered renderer (proving
  // the `/^mcp__[^_]+__(.+)$/` short-segment key, NOT the raw namespaced
  // name), and an unregistered built-in (`Read`) still falls back (undefined).
  it("collapses the <server> segment and falls back for unregistered built-ins", () => {
    const canonical = resolveToolRenderer("mcp__friday-mail__mail_send");
    const variableServer = resolveToolRenderer("mcp__friday-anything__mail_send");
    expect(variableServer).toBeDefined();
    expect(variableServer!.component).toBe(MailToolBlock);
    // Same registered reference regardless of the server segment.
    expect(variableServer).toBe(canonical);

    // An unregistered built-in still falls back to ToolBlock (undefined).
    expect(resolveToolRenderer("Read")).toBe(undefined);
  });

  it("registers exactly the four mail short names at module load", () => {
    for (const k of ["mail_send", "mail_inbox", "mail_read", "mail_close"]) {
      expect(TOOL_RENDERERS[k]?.component).toBe(MailToolBlock);
    }
  });
});

describe("ScheduleWakeup renderer registration", () => {
  it("resolves 'ScheduleWakeup' to ScheduleWakeupBlock", () => {
    const renderer = resolveToolRenderer("ScheduleWakeup");
    expect(renderer).toBeDefined();
    expect(renderer!.component).toBe(ScheduleWakeupBlock);
  });

  it("does not mark ScheduleWakeup as direct (card, not inline)", () => {
    const renderer = resolveToolRenderer("ScheduleWakeup");
    expect(renderer!.direct).toBeFalsy();
  });
});
