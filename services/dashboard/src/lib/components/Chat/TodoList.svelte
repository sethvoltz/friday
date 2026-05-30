<script lang="ts">
  import { CheckSquare, CircleDot, Square } from "lucide-svelte";
  import type { ToolRendererProps } from "./tool-renderers";
  import { synthesizeHeadline } from "./tool-headlines";
  import CollapsibleSection from "./CollapsibleSection.svelte";
  import { parseTodos, rowLabel, rowState } from "./todo-render";

  // Purpose-built renderer for `TodoWrite` tool blocks (FRI-133). Renders the
  // agent's task list directly — one row per todo, in input order, with a
  // per-status visual state indicator — instead of the generic collapsed
  // JSON card. Registered against FRI-130's dispatch registry on the literal
  // key "TodoWrite".
  //
  // Declares all six props of `ToolRendererProps` for contract conformance
  // (the dispatch site spreads the same six-prop bag into either ToolBlock or
  // this renderer). Only `input` and `status` are used: the canonical task
  // state is `input.todos`; the tool_result `output` is a confirmation string
  // and is deliberately NOT rendered. `inputPartialJson` is ignored — partial
  // streaming of a todo list is skipped; the canonical `input` lands at
  // block_complete.
  // All six props of `ToolRendererProps` are declared for contract
  // conformance (the dispatch site spreads the same six-prop bag into either
  // ToolBlock or this renderer). The unused props are intentionally prefixed
  // out of the destructure-rest below; only `toolName`, `status`, and `input`
  // are read. Declaring fewer than six would fail `svelte-check`.
  let {
    toolName,
    input,
    // accepted for contract conformance, unused by this renderer:
    friendlyName: _friendlyName,
    status: _status,
    inputPartialJson: _inputPartialJson,
    output: _output,
  }: ToolRendererProps = $props();

  let todos = $derived(parseTodos(input));
  // Header label reuses the existing `Updating todos (N)` headline (untouched
  // upstream). Falls back gracefully when there are no parsed rows.
  let headline = $derived(synthesizeHeadline(toolName, input) ?? `Updating todos (${todos.length})`);
</script>

<div class="todo-block">
  {#if todos.length > 0}
    <CollapsibleSection label={headline} startOpen={true} collapsedMaxHeight={320}>
      <ul class="todo-list">
        {#each todos as todo, i (i)}
          {@const marker = rowState(todo.status)}
          <li class="todo-row" data-todo-status={todo.status}>
            <span class="todo-marker" data-marker={marker} aria-hidden="true">
              {#if marker === "checked"}
                <CheckSquare size={15} />
              {:else if marker === "active"}
                <CircleDot size={15} />
              {:else}
                <Square size={15} />
              {/if}
            </span>
            <span class="todo-label" class:done={marker === "checked"}>{rowLabel(todo)}</span>
          </li>
        {/each}
      </ul>
    </CollapsibleSection>
  {:else}
    <div class="todo-empty">{headline}</div>
  {/if}
</div>

<style>
  .todo-block {
    border-left: 2px solid var(--accent-primary);
    padding: 0.25rem 0;
    font-size: 0.85rem;
  }
  .todo-list {
    list-style: none;
    margin: 0.25rem 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .todo-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.15rem 0.75rem;
  }
  .todo-marker {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    margin-top: 0.1rem;
  }
  .todo-marker[data-marker="checked"] {
    color: var(--status-ok, var(--accent-primary));
  }
  .todo-marker[data-marker="active"] {
    color: var(--accent-primary);
  }
  .todo-marker[data-marker="empty"] {
    color: var(--text-tertiary);
  }
  .todo-label {
    color: var(--text-primary);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .todo-row[data-todo-status="in_progress"] .todo-label {
    font-weight: 600;
  }
  .todo-label.done {
    text-decoration: line-through;
    color: var(--text-tertiary);
  }
  .todo-empty {
    padding: 0.25rem 0.75rem;
    color: var(--text-tertiary);
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
</style>
