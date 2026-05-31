// Pure input-shape mapping for the file-edit tool family (FRI-134).
//
// The four file-edit tools — `Write`, `Edit`, `MultiEdit`, `NotebookEdit` —
// each arrive as a `role === "tool"` block whose `input` is the raw SDK
// tool_use payload (snake_case). `FileEditRenderer.svelte` mounts `FileDiff`
// directly; this module is the pure, DOM-free seam that translates the raw
// `input` into FileDiff's camelCase props. Keeping it pure (no Svelte, no
// DOM) lets the dashboard's node test pool unit-test the mapping without
// `@testing-library/svelte`.
//
// Defensiveness mirrors ToolBlock's `inputField()` helper: any field that is
// missing or of the wrong type maps to `undefined`/`[]` rather than throwing.
// In particular the daemon's streaming-fallback shape `{ _raw: <partialJson> }`
// (block-stream.ts:190, worker.ts:506) carries no `file_path`/`old_string`,
// so the mapping yields empty props and FileDiff renders a benign placeholder
// instead of crashing.

/** The four file-edit tool names this family covers. */
export type FileEditToolName = "Write" | "Edit" | "MultiEdit" | "NotebookEdit";

/** A single MultiEdit hunk, mapped to FileDiff's camelCase contract. */
export interface FileEditHunk {
  oldString: string;
  newString: string;
}

/** The prop bag FileDiff consumes, derived purely from a raw tool input. */
export interface FileDiffProps {
  toolName: FileEditToolName;
  filePath?: string;
  /** Write content, or NotebookEdit `new_source` for replace/insert. */
  content?: string;
  /** Edit single-hunk old text. */
  oldString?: string;
  /** Edit single-hunk new text. */
  newString?: string;
  /** MultiEdit: K hunks, one per `edits[]` entry. */
  edits?: FileEditHunk[];
  /** NotebookEdit cell type (display + Shiki lang hint). */
  cellType?: "code" | "markdown";
  /** NotebookEdit edit mode (`delete` renders a "cell deleted" notice). */
  editMode?: "replace" | "insert" | "delete";
}

export const FILE_EDIT_TOOL_NAMES: readonly FileEditToolName[] = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
] as const;

export function isFileEditToolName(name: string): name is FileEditToolName {
  return (FILE_EDIT_TOOL_NAMES as readonly string[]).includes(name);
}

/** Narrow an unknown to a plain (non-array) object, else `undefined`. */
function asObj(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

/** Read a string field, or `undefined` when missing/non-string. */
function str(o: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!o) return undefined;
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Map a raw file-edit tool input to FileDiff's camelCase props.
 *
 * Always returns an object carrying at least `toolName`; every other field is
 * optional and absent when the corresponding raw key is missing or wrong-typed
 * (e.g. the `{ _raw }` streaming-fallback input maps to just `{ toolName }`).
 */
export function mapFileEditInput(toolName: FileEditToolName, input: unknown): FileDiffProps {
  const o = asObj(input);

  switch (toolName) {
    case "Write": {
      return {
        toolName,
        filePath: str(o, "file_path") ?? str(o, "path"),
        content: str(o, "content"),
      };
    }
    case "Edit": {
      return {
        toolName,
        filePath: str(o, "file_path") ?? str(o, "path"),
        oldString: str(o, "old_string"),
        newString: str(o, "new_string"),
      };
    }
    case "MultiEdit": {
      const rawEdits = o?.edits;
      const edits: FileEditHunk[] = Array.isArray(rawEdits)
        ? rawEdits.flatMap((e): FileEditHunk[] => {
            const eo = asObj(e);
            const oldString = str(eo, "old_string");
            const newString = str(eo, "new_string");
            // A hunk needs both sides to render a diff; drop malformed entries
            // rather than feeding `undefined` into `diffLines`.
            if (oldString === undefined || newString === undefined) return [];
            return [{ oldString, newString }];
          })
        : [];
      return {
        toolName,
        filePath: str(o, "file_path") ?? str(o, "path"),
        edits,
      };
    }
    case "NotebookEdit": {
      const rawCellType = str(o, "cell_type");
      const cellType =
        rawCellType === "code" || rawCellType === "markdown" ? rawCellType : undefined;
      const rawEditMode = str(o, "edit_mode");
      const editMode =
        rawEditMode === "replace" || rawEditMode === "insert" || rawEditMode === "delete"
          ? rawEditMode
          : undefined;
      return {
        toolName,
        // NotebookEdit carries no old-source, so this is a content view (like
        // Write), not a two-sided diff. `notebook_path` is the canonical key;
        // `file_path` is a defensive fallback.
        filePath: str(o, "notebook_path") ?? str(o, "file_path"),
        content: str(o, "new_source"),
        cellType,
        editMode,
      };
    }
  }
}
