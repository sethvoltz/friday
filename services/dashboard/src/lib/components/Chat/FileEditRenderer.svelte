<script lang="ts">
  // Shown-directly file-edit renderer (FRI-134, header/containment restored
  // in FRI-137). Registered in `tool-renderers.ts` for `Write` / `Edit` /
  // `MultiEdit` / `NotebookEdit`, it promotes the diff to a top-level block —
  // no collapsed generic tool card to expand first.
  //
  // It is a thin adapter: it accepts the full six-prop `ToolRendererProps`
  // contract (so the dispatch site can spread one prop bag into either this
  // or `ToolBlock`), maps the raw `input` to FileDiff's camelCase props via
  // the pure `mapFileEditInput`, computes the aliased filename headline via
  // the SAME `synthesizeHeadline` helper the old ToolBlock used (so the
  // header reads "Editing ~/a/b.ts" / "Writing @apps/foo/index.html"), and
  // mounts `<FileDiff/>` directly. The single height cap + `+`/`−` control
  // lives inside FileDiff's FRI-130 CollapsibleSection (collapsedMaxHeight
  // 400). Exactly one cap, one scroll container.
  import { page } from "$app/stores";
  import FileDiff from "./FileDiff.svelte";
  import { mapFileEditInput, isFileEditToolName } from "./file-edit-input";
  import { synthesizeHeadline } from "./tool-headlines";

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
  // `friendlyName` / `inputPartialJson` / `output` are accepted so the
  // dispatch-site prop spread typechecks against ToolRendererProps, but a
  // file-edit shows its diff, not a tool pill — only `toolName` + `input` +
  // `status` feed the render. The remaining props are collected into `_rest`
  // (underscore-prefixed so it's exempt from unused-var checks).
  let { toolName, status, input, ..._rest }: Props = $props();

  // homeDir / dataDir reach renderers via `$page.data` (set in
  // +layout.server.ts), exactly as ToolBlock reads them — NOT a new prop. The
  // read-only past-session ChatShell carries the same data, so the aliasing
  // resolves there too; when absent the headline falls back to the raw path.
  let homeDir = $derived((($page.data as { homeDir?: string | null } | undefined)?.homeDir) ?? null);
  let dataDir = $derived((($page.data as { dataDir?: string | null } | undefined)?.dataDir) ?? null);

  // Defensive: this renderer is only registered for the four file-edit names,
  // but guard anyway so a stray registration can't feed FileDiff an
  // unsupported toolName. The `{ _raw }` streaming-fallback input maps to a
  // props bag carrying only `toolName`, so FileDiff renders a benign
  // placeholder ("No diff available" / empty content) rather than crashing.
  let diffProps = $derived(
    isFileEditToolName(toolName) ? mapFileEditInput(toolName, input) : undefined,
  );

  // Aliased filename header (FRI-137). Reuses the EXACT helper the old
  // ToolBlock headline used — `synthesizeHeadline(toolName, input)` returns
  // "Editing ~/a/b.ts" / "Writing @apps/foo/index.html" / "Editing … (N
  // edits)". Falls back to the raw file path, then to the tool name, so the
  // header is never empty (e.g. mid-stream before `input` lands).
  let headline = $derived(
    synthesizeHeadline(toolName, input, { homeDir, dataDir }) ?? diffProps?.filePath ?? toolName,
  );
</script>

{#if diffProps}
  <FileDiff
    toolName={diffProps.toolName}
    headline={headline}
    status={status}
    filePath={diffProps.filePath}
    content={diffProps.content}
    oldString={diffProps.oldString}
    newString={diffProps.newString}
    edits={diffProps.edits}
    cellType={diffProps.cellType}
    editMode={diffProps.editMode} />
{/if}
