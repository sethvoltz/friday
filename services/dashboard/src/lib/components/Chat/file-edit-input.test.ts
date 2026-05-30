import { describe, it, expect } from "vitest";
import { mapFileEditInput, isFileEditToolName, FILE_EDIT_TOOL_NAMES } from "./file-edit-input";

describe("isFileEditToolName", () => {
  it("recognizes exactly the four file-edit tools", () => {
    expect(FILE_EDIT_TOOL_NAMES).toEqual(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
    for (const n of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      expect(isFileEditToolName(n)).toBe(true);
    }
  });

  it("rejects Read and arbitrary names", () => {
    expect(isFileEditToolName("Read")).toBe(false);
    expect(isFileEditToolName("Bash")).toBe(false);
    expect(isFileEditToolName("")).toBe(false);
  });
});

describe("mapFileEditInput — Write", () => {
  it("maps file_path + content to camelCase content props", () => {
    expect(mapFileEditInput("Write", { file_path: "/a/b.ts", content: "hello" })).toEqual({
      toolName: "Write",
      filePath: "/a/b.ts",
      content: "hello",
    });
  });

  it("falls back to `path` when `file_path` is absent", () => {
    expect(mapFileEditInput("Write", { path: "/a/b.ts", content: "x" })).toMatchObject({
      filePath: "/a/b.ts",
    });
  });
});

describe("mapFileEditInput — Edit", () => {
  it("maps old_string/new_string to oldString/newString", () => {
    expect(
      mapFileEditInput("Edit", {
        file_path: "/a/b.ts",
        old_string: "before",
        new_string: "after",
        replace_all: false,
      }),
    ).toEqual({
      toolName: "Edit",
      filePath: "/a/b.ts",
      oldString: "before",
      newString: "after",
    });
  });
});

describe("mapFileEditInput — MultiEdit (AC#4)", () => {
  it("maps a 3-edit input to exactly 3 hunk descriptors with mapped keys", () => {
    const out = mapFileEditInput("MultiEdit", {
      file_path: "/a/b.ts",
      edits: [
        { old_string: "o1", new_string: "n1" },
        { old_string: "o2", new_string: "n2", replace_all: true },
        { old_string: "o3", new_string: "n3" },
      ],
    });

    expect(out.toolName).toBe("MultiEdit");
    expect(out.filePath).toBe("/a/b.ts");
    expect(out.edits).toHaveLength(3);
    expect(out.edits).toEqual([
      { oldString: "o1", newString: "n1" },
      { oldString: "o2", newString: "n2" },
      { oldString: "o3", newString: "n3" },
    ]);
  });

  it("drops malformed edit entries (missing old/new) rather than emitting undefined hunks", () => {
    const out = mapFileEditInput("MultiEdit", {
      file_path: "/a/b.ts",
      edits: [
        { old_string: "o1", new_string: "n1" },
        { old_string: "o2" }, // missing new_string — dropped
        { new_string: "n3" }, // missing old_string — dropped
        "not-an-object", // dropped
      ],
    });
    expect(out.edits).toEqual([{ oldString: "o1", newString: "n1" }]);
  });

  it("yields an empty edits array when `edits` is absent or not an array", () => {
    expect(mapFileEditInput("MultiEdit", { file_path: "/a/b.ts" }).edits).toEqual([]);
    expect(mapFileEditInput("MultiEdit", { file_path: "/a/b.ts", edits: "x" }).edits).toEqual([]);
  });
});

describe("mapFileEditInput — NotebookEdit (AC#5 mapping)", () => {
  it("maps notebook_path/new_source/cell_type/edit_mode to a content view", () => {
    expect(
      mapFileEditInput("NotebookEdit", {
        notebook_path: "/a/nb.ipynb",
        new_source: "print('hi')",
        cell_type: "code",
        edit_mode: "replace",
      }),
    ).toEqual({
      toolName: "NotebookEdit",
      filePath: "/a/nb.ipynb",
      content: "print('hi')",
      cellType: "code",
      editMode: "replace",
    });
  });

  it("preserves a delete edit_mode (FileDiff renders a 'cell deleted' notice)", () => {
    const out = mapFileEditInput("NotebookEdit", {
      notebook_path: "/a/nb.ipynb",
      edit_mode: "delete",
    });
    expect(out.editMode).toBe("delete");
    expect(out.content).toBeUndefined();
  });

  it("drops an out-of-range cell_type / edit_mode to undefined", () => {
    const out = mapFileEditInput("NotebookEdit", {
      notebook_path: "/a/nb.ipynb",
      new_source: "x",
      cell_type: "bogus",
      edit_mode: "weird",
    });
    expect(out.cellType).toBeUndefined();
    expect(out.editMode).toBeUndefined();
  });
});

describe("mapFileEditInput — streaming-fallback tolerance (AC#10)", () => {
  it("maps the { _raw } partial-JSON fallback to benign empty props without throwing", () => {
    // block-stream.ts:190 writes `input = { _raw: <partialJson> }` when the
    // streamed partial fails to parse. The adapter must tolerate it.
    const raw = { _raw: '{"file_path":"/a' };
    for (const tool of FILE_EDIT_TOOL_NAMES) {
      const out = mapFileEditInput(tool, raw);
      expect(out.toolName).toBe(tool);
      // No file/diff fields recovered — FileDiff renders a placeholder.
      expect(out.filePath).toBeUndefined();
      expect(out.content).toBeUndefined();
      expect(out.oldString).toBeUndefined();
      expect(out.newString).toBeUndefined();
    }
    // MultiEdit specifically yields an empty edits array (not undefined).
    expect(mapFileEditInput("MultiEdit", raw).edits).toEqual([]);
  });

  it("tolerates non-object inputs (null/undefined/string) without throwing", () => {
    for (const bad of [null, undefined, "str", 42, []]) {
      for (const tool of FILE_EDIT_TOOL_NAMES) {
        expect(() => mapFileEditInput(tool, bad)).not.toThrow();
        const out = mapFileEditInput(tool, bad);
        expect(out.toolName).toBe(tool);
        expect(out.filePath).toBeUndefined();
      }
    }
  });
});
