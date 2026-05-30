// Pure render helpers for the TodoWrite task-list renderer (FRI-133).
//
// These live in a sibling `.ts` module (NOT a `<script module>` export from
// TodoList.svelte) so they are unambiguously importable under the dashboard's
// node/forks vitest pool, which has no vite-svelte plugin and no DOM. The
// TodoList.svelte component consumes these; the unit test exercises them
// directly.

/** The TodoWrite per-row status enum, verbatim from the Claude Agent SDK
 *  `TodoWriteInput` type (`sdk-tools.d.ts`). Pinned as a literal union so a
 *  future SDK enum drift breaks the build (see `rowState`'s exhaustive
 *  `never` default). NOT the ticket-store status enum — unrelated domain. */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** One parsed todo row. Shape mirrors the SDK `TodoWriteInput.todos[number]`
 *  (`content`, `activeForm`, `status`). */
export interface Todo {
  content: string;
  activeForm: string;
  status: TodoStatus;
}

/** Marker token per status — what visual state the row's indicator renders.
 *  `checked` = completed (struck-through), `active` = in_progress,
 *  `empty` = pending. Distinct per status so the component can branch on a
 *  single token and tests can pin each mapping. */
export type Marker = "checked" | "active" | "empty";

function isTodoStatus(v: unknown): v is TodoStatus {
  return v === "pending" || v === "in_progress" || v === "completed";
}

/**
 * Safely read `input.todos` into a typed array, preserving input order.
 * Returns `[]` when `input` is not an object, `todos` is not an array, or a
 * row is malformed — never throws. This is the unit-testable parsing seam;
 * the canonical TodoWrite state is the `input.todos` array (the tool_result
 * `output` confirmation string is ignored by the renderer).
 */
export function parseTodos(input: unknown): Todo[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const todos = (input as Record<string, unknown>).todos;
  if (!Array.isArray(todos)) return [];
  const out: Todo[] = [];
  for (const raw of todos) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (!isTodoStatus(r.status)) continue;
    out.push({
      content: typeof r.content === "string" ? r.content : "",
      activeForm: typeof r.activeForm === "string" ? r.activeForm : "",
      status: r.status,
    });
  }
  return out;
}

/**
 * The label text to display for a row. `activeForm` (present-continuous,
 * e.g. "Researching the SDK type") for `in_progress` rows; `content` (the
 * imperative, e.g. "Research the SDK type") for `pending` / `completed`.
 * Per-row fallback when the chosen field is empty so a row never renders
 * blank: in_progress → content; non-in_progress → activeForm.
 */
export function rowLabel(todo: Pick<Todo, "content" | "activeForm" | "status">): string {
  if (todo.status === "in_progress") {
    return todo.activeForm.length > 0 ? todo.activeForm : todo.content;
  }
  return todo.content.length > 0 ? todo.content : todo.activeForm;
}

/**
 * Map a status to its visual marker token. Exhaustive over `TodoStatus`; the
 * `never`-typed default makes an added SDK enum value a compile error rather
 * than a silently-unhandled row.
 */
export function rowState(status: TodoStatus): Marker {
  switch (status) {
    case "completed":
      return "checked";
    case "in_progress":
      return "active";
    case "pending":
      return "empty";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
