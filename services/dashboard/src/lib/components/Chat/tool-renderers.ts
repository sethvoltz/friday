import type { Component } from "svelte";
import TodoList from "./TodoList.svelte";
import FileEditRenderer from "./FileEditRenderer.svelte";

/**
 * Per-tool render dispatch for chat tool-use blocks (FRI-130 foundation).
 *
 * ChatMessages routes every `role === "tool"` block through
 * `resolveToolRenderer(toolName)`. When a purpose-built renderer is
 * registered for that tool it is mounted; otherwise the resolver returns
 * `undefined` and the caller falls back to the generic `ToolBlock` — so an
 * unregistered tool renders exactly as it does today.
 *
 * ## How a downstream renderer ticket (A/B/C) ships a feature
 *
 * 1. Create `XRenderer.svelte` whose `Props` match `ToolRendererProps`
 *    (all six props — `toolName`, `friendlyName?`, `status`, `input?`,
 *    `inputPartialJson?`, `output?`). The dispatch site spreads the same
 *    prop bag into either ToolBlock or your renderer, so a renderer built
 *    against a narrower contract would silently drop the streaming-partial
 *    or friendly-name inputs.
 * 2. Wrap the directly-shown body in `CollapsibleSection` so it inherits
 *    the height cap + the `+`/`−` disclosure convention for free.
 * 3. Add one line: `TOOL_RENDERERS["<key>"] = { component: XRenderer };`
 *
 * ## Key rule (built-in literal vs MCP short segment)
 *
 * The registry is keyed by:
 *   - the **literal tool name** for built-in tools — e.g. `"TodoWrite"`,
 *     `"Write"`, `"Edit"`; and
 *   - the **MCP short segment** for friday MCP tools — the `(.+)` capture
 *     of `/^mcp__[^_]+__(.+)$/`, e.g. `"mail_send"` for the raw tool
 *     `"mcp__friday-mail__mail_send"` (the `<server>` segment varies and is
 *     intentionally NOT part of the key).
 *
 * Do NOT key on `friendlyToolName` output: for friday MCP tools whose short
 * name is in `FRIDAY_MCP_FRIENDLY` (tool-headlines.ts) that function returns
 * a human label (e.g. `"Create agent"`), which is a useless registry key.
 * `resolveToolRenderer` normalizes via the short-segment capture instead.
 *
 * Lookup precedence is raw-name-first, so a literal-name registration always
 * wins over an MCP short-segment match (no built-in is MCP-shaped today).
 */

/**
 * The prop contract every per-tool renderer accepts. Mirrors all six props
 * `ToolBlock` receives at the dispatch site (ChatMessages.svelte) so the
 * caller can spread the same prop bag into either ToolBlock or a registered
 * renderer without branching the prop set.
 */
export type ToolRendererProps = {
  toolName: string;
  friendlyName?: string;
  status: "running" | "done" | "error" | "aborted";
  input?: unknown;
  inputPartialJson?: string;
  output?: string;
};

/**
 * A registered renderer. `direct` is reserved for "shown-directly"
 * renderers (rendered inline rather than behind a collapsed generic card);
 * it is unused by the foundation and consumed by the A/B/C tickets.
 */
export type ToolRenderer = {
  component: Component<ToolRendererProps>;
  direct?: boolean;
};

/**
 * Tool-name → renderer map. Ships **empty** in the foundation ticket; the
 * downstream renderer tickets (A: TodoWrite, B: file-edit diff, C:
 * friday-mail `mail_send`) populate it.
 *
 * This is a mutable `const` binding — its properties are assignable (it is
 * intentionally NOT frozen) and `resolveToolRenderer` closes over this exact
 * object, so a registration (or a test-time assignment) is visible to the
 * resolver immediately.
 */
export const TOOL_RENDERERS: Record<string, ToolRenderer> = {};

// FRI-133 (renderer A): TodoWrite is a built-in tool (no `mcp__` prefix), so
// it resolves at step (1) of `resolveToolRenderer` on its literal name — the
// registry key stays `"TodoWrite"`. Renders the task list directly instead of
// the generic collapsed JSON card.
TOOL_RENDERERS["TodoWrite"] = { component: TodoList };

// FRI-134 (ticket B): promote the file-edit diff to a shown-directly,
// height-capped block. All four file-edit tools share one thin adapter
// (`FileEditRenderer`) that maps the raw input to FileDiff's props and mounts
// FileDiff directly — no collapsed tool card. All four are built-in literal
// names (no `mcp__` prefix), so they resolve at step (1) of
// `resolveToolRenderer` (raw-name match). `direct: true` marks them
// shown-directly. `Read` is intentionally NOT registered (no diff to show) —
// it stays on the generic ToolBlock.
const fileEditRenderer: ToolRenderer = { component: FileEditRenderer, direct: true };
TOOL_RENDERERS["Write"] = fileEditRenderer;
TOOL_RENDERERS["Edit"] = fileEditRenderer;
TOOL_RENDERERS["MultiEdit"] = fileEditRenderer;
TOOL_RENDERERS["NotebookEdit"] = fileEditRenderer;

const MCP_TOOL_RE = /^mcp__[^_]+__(.+)$/;

/**
 * Resolve the renderer for a tool-use block, or `undefined` when none is
 * registered (caller falls back to the generic ToolBlock).
 *
 * Lookup order:
 *   1. the raw `toolName` (built-in literal, e.g. `TodoWrite`/`Write`/`Edit`);
 *   2. the MCP short segment via `/^mcp__[^_]+__(.+)$/` (e.g. `mail_send`
 *      for `mcp__friday-<server>__mail_send`, for any `<server>`).
 */
export function resolveToolRenderer(toolName: string): ToolRenderer | undefined {
  const direct = TOOL_RENDERERS[toolName];
  if (direct) return direct;
  const mcp = MCP_TOOL_RE.exec(toolName);
  if (mcp) return TOOL_RENDERERS[mcp[1]];
  return undefined;
}
