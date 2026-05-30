import { describe, expect, it } from "vitest";
import { parseTodos, rowLabel, rowState, type Marker, type TodoStatus } from "./todo-render";
import { resolveToolRenderer, TOOL_RENDERERS } from "./tool-renderers";
import TodoList from "./TodoList.svelte";

// FRI-133 — pure-`.ts` unit coverage for the TodoWrite renderer's logic seam.
// The dashboard vitest pool is node (no DOM, no @testing-library/svelte), so
// these tests exercise the exported helpers in `todo-render.ts` and the
// resolver-level registration in `tool-renderers.ts`. The DOM-visual ACs
// (line-through, activeForm-in-DOM, row count/order) are owned by Playwright
// (AC#7), recorded as an unchecked implementer item — the existing e2e
// harness has no precedent for standing up an agent tool block.

describe("parseTodos", () => {
  // AC#2 — shape + order preserved (N items → N rows at the logic layer).
  it("parses todos in input order, one parsed row per input item", () => {
    const result = parseTodos({
      todos: [
        { content: "a", activeForm: "A", status: "pending" },
        { content: "b", activeForm: "B", status: "in_progress" },
        { content: "c", activeForm: "C", status: "completed" },
      ],
    });
    expect(result.length).toBe(3);
    expect(result[0]).toMatchObject({ content: "a", activeForm: "A", status: "pending" });
    expect(result[1]!.status).toBe("in_progress");
    expect(result[2]).toMatchObject({ content: "c", activeForm: "C", status: "completed" });
  });

  // AC#3 — robustness: malformed inputs yield exactly `[]`, never throw.
  it("returns [] for non-object / non-array-todos / null inputs (never throws)", () => {
    expect(parseTodos(undefined)).toEqual([]);
    expect(parseTodos({})).toEqual([]);
    expect(parseTodos({ todos: "nope" })).toEqual([]);
    expect(parseTodos({ todos: 42 })).toEqual([]);
    expect(parseTodos(null)).toEqual([]);
  });

  it("skips malformed rows (missing/invalid status) but keeps valid siblings in order", () => {
    const result = parseTodos({
      todos: [
        { content: "ok", activeForm: "OK", status: "pending" },
        { content: "bad-status", activeForm: "X", status: "wat" },
        "not-an-object",
        { content: "ok2", activeForm: "OK2", status: "completed" },
      ],
    });
    expect(result.length).toBe(2);
    expect(result[0]).toMatchObject({ content: "ok", status: "pending" });
    expect(result[1]).toMatchObject({ content: "ok2", status: "completed" });
  });
});

describe("rowLabel", () => {
  // AC#4 — activeForm for in_progress, content for pending/completed.
  it("returns activeForm for an in_progress todo", () => {
    expect(rowLabel({ content: "Do X", activeForm: "Doing X", status: "in_progress" })).toBe(
      "Doing X",
    );
  });

  it("returns content for pending and completed todos", () => {
    expect(rowLabel({ content: "Do X", activeForm: "Doing X", status: "pending" })).toBe("Do X");
    expect(rowLabel({ content: "Do X", activeForm: "Doing X", status: "completed" })).toBe("Do X");
  });

  // AC#4 / AC#8 — per-row blank fallback so a row never renders empty.
  it("falls back to content when an in_progress activeForm is empty", () => {
    expect(rowLabel({ content: "Do X", activeForm: "", status: "in_progress" })).toBe("Do X");
  });

  it("falls back to activeForm when a non-in_progress content is empty", () => {
    expect(rowLabel({ content: "", activeForm: "Doing X", status: "pending" })).toBe("Doing X");
  });
});

describe("rowState", () => {
  // AC#5 — status enum pinned; one distinct marker token per status.
  it("maps each status to a distinct marker token", () => {
    expect(rowState("completed")).toBe("checked");
    expect(rowState("in_progress")).toBe("active");
    expect(rowState("pending")).toBe("empty");
  });

  it("covers every member of the literal status union exhaustively", () => {
    // Exhaustive Record over the literal union — adding/removing an SDK enum
    // member would break the build here (and via rowState's `never` default).
    const markers: Record<TodoStatus, Marker> = {
      pending: rowState("pending"),
      in_progress: rowState("in_progress"),
      completed: rowState("completed"),
    };
    expect(markers).toEqual({ pending: "empty", in_progress: "active", completed: "checked" });
    // All three tokens are distinct.
    expect(new Set(Object.values(markers)).size).toBe(3);
  });
});

describe("TodoWrite registration (AC#6)", () => {
  it("registers TodoWrite on its literal built-in key, resolved at step (1)", () => {
    // Raw-name (step 1) hit: TodoWrite has no `mcp__` prefix, so it resolves
    // on its literal key, NOT via the MCP short-segment path (step 2).
    const r = resolveToolRenderer("TodoWrite");
    expect(r).toBeDefined();
    expect(r!.component).toBe(TodoList);
    // Same identity as the live map entry — proves the registration, not a
    // coincidental match.
    expect(TOOL_RENDERERS["TodoWrite"]!.component).toBe(TodoList);
  });
});
