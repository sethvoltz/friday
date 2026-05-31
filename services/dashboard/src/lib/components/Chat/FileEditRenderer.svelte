<script lang="ts">
  // Shown-directly file-edit renderer (FRI-134). Registered in
  // `tool-renderers.ts` for `Write` / `Edit` / `MultiEdit` / `NotebookEdit`,
  // it promotes the diff to a top-level block — no collapsed tool card to
  // expand first. It is a thin adapter: it accepts the full six-prop
  // `ToolRendererProps` contract (so the dispatch site can spread one prop
  // bag into either this or `ToolBlock`), maps the raw `input` to FileDiff's
  // camelCase props via the pure `mapFileEditInput`, and mounts `<FileDiff/>`
  // directly. It adds NO `CollapsibleSection` of its own — the single height
  // cap + `+`/`−` control lives inside FileDiff's FRI-130 CollapsibleSection
  // (collapsedMaxHeight=400). Exactly one cap, one scroll container.
  import FileDiff from "./FileDiff.svelte";
  import { mapFileEditInput, isFileEditToolName } from "./file-edit-input";

  interface Props {
    // All six ToolRendererProps fields so the dispatch-site prop spread
    // typechecks. `friendlyName` / `inputPartialJson` / `output` are accepted
    // but unused for rendering (a file-edit shows its diff, not a tool pill).
    toolName: string;
    friendlyName?: string;
    status: "running" | "done" | "error" | "aborted";
    input?: unknown;
    inputPartialJson?: string;
    output?: string;
  }
  // `friendlyName` / `inputPartialJson` / `output` / `status` are accepted so
  // the dispatch-site prop spread typechecks against ToolRendererProps, but a
  // file-edit shows its diff, not a tool pill — only `toolName` + `input` feed
  // the render. The remaining props are collected into `_rest` (underscore-
  // prefixed so it's exempt from unused-var checks) to keep the full six-prop
  // surface bound without referencing them at runtime.
  let { toolName, input, ..._rest }: Props = $props();

  // Defensive: this renderer is only registered for the four file-edit names,
  // but guard anyway so a stray registration can't feed FileDiff an
  // unsupported toolName. The `{ _raw }` streaming-fallback input maps to a
  // props bag carrying only `toolName`, so FileDiff renders a benign
  // placeholder ("No diff available" / empty content) rather than crashing.
  let diffProps = $derived(
    isFileEditToolName(toolName) ? mapFileEditInput(toolName, input) : undefined,
  );
</script>

{#if diffProps}
  <FileDiff
    toolName={diffProps.toolName}
    filePath={diffProps.filePath}
    content={diffProps.content}
    oldString={diffProps.oldString}
    newString={diffProps.newString}
    edits={diffProps.edits}
    cellType={diffProps.cellType}
    editMode={diffProps.editMode} />
{/if}
