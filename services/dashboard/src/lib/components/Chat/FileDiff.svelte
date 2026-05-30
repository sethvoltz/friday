<script lang="ts">
  import { diffLines } from "diff";
  import type { Change } from "diff";
  import { theme } from "$lib/stores/theme.svelte";
  import { shikiThemeFor } from "$lib/theme/palettes";
  import CollapsibleSection from "./CollapsibleSection.svelte";

  interface Props {
    toolName: "Write" | "Edit";
    filePath?: string;
    content?: string;
    oldString?: string;
    newString?: string;
  }
  let { toolName, filePath, content, oldString, newString }: Props = $props();

  // Expansion state is owned by CollapsibleSection (FRI-130) and bound back
  // here so the shiki `$effect` gate below can lazy-load the highlighter
  // only when the content is actually revealed. Defaults expanded to match
  // FileDiff's prior `open = $state(true)` behavior.
  let expanded = $state(true);

  function langFromPath(p: string | undefined): string {
    if (!p) return "text";
    const ext = p.split(".").pop()?.toLowerCase() ?? "";
    const map: Record<string, string> = {
      ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
      svelte: "svelte", vue: "vue", html: "html", css: "css",
      scss: "scss", less: "less", json: "json", jsonc: "jsonc",
      md: "markdown", mdx: "mdx", py: "python", rb: "ruby",
      go: "go", rs: "rust", java: "java", kt: "kotlin",
      sh: "bash", zsh: "bash", fish: "fish", sql: "sql",
      yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
      graphql: "graphql", gql: "graphql", tf: "hcl",
    };
    return map[ext] ?? "text";
  }

  // Shiki lazy-load, same pattern as Markdown.svelte. FRI-124: single-
  // theme per active palette; the dual-theme defaultColor:false trick
  // is gone. Re-highlights on palette change by clearing
  // `highlightedHtml`.
  type ShikiApi = {
    codeToHtml: (code: string, opts: { lang: string; theme: string }) => Promise<string>;
  };
  let shikiApi: ShikiApi | null = null;
  let highlightedHtml = $state<string | null>(null);
  // svelte-ignore state_referenced_locally
  let lastPalette = $state<string>(theme.activePalette);

  $effect(() => {
    // Reset the cached highlight when the palette changes so the next
    // render goes through the new shikiTheme.
    if (theme.activePalette !== lastPalette) {
      lastPalette = theme.activePalette;
      highlightedHtml = null;
    }
  });

  $effect(() => {
    if (!expanded || toolName !== "Write" || !content) return;
    if (highlightedHtml !== null) return;
    const lang = langFromPath(filePath);
    const shikiTheme = shikiThemeFor(theme.activePalette);
    void (async () => {
      if (!shikiApi) {
        const mod = await import("shiki");
        shikiApi = mod as unknown as ShikiApi;
      }
      const out = await shikiApi.codeToHtml(content ?? "", {
        lang,
        theme: shikiTheme,
      });
      const tmp = document.createElement("div");
      tmp.innerHTML = out;
      highlightedHtml = tmp.querySelector("code")?.innerHTML ?? null;
    })();
  });

  type DiffLine = { kind: "added" | "removed" | "unchanged"; text: string };

  let diffLines_ = $derived.by((): DiffLine[] => {
    if (toolName !== "Edit" || !oldString || !newString) return [];
    const changes: Change[] = diffLines(oldString, newString);
    const result: DiffLine[] = [];
    for (const c of changes) {
      const lines = c.value.split("\n");
      // diffLines includes a trailing empty string when value ends with \n
      const meaningful = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
      for (const line of meaningful) {
        result.push({
          kind: c.added ? "added" : c.removed ? "removed" : "unchanged",
          text: line,
        });
      }
    }
    return result;
  });

  // For side-by-side: pair up removed/added lines
  type SideBySidePair = { left: DiffLine | null; right: DiffLine | null };

  let sideBySide = $derived.by((): SideBySidePair[] => {
    const pairs: SideBySidePair[] = [];
    let i = 0;
    while (i < diffLines_.length) {
      const cur = diffLines_[i];
      if (cur.kind === "unchanged") {
        pairs.push({ left: cur, right: cur });
        i++;
      } else if (cur.kind === "removed") {
        // Peek at next for a matching added line
        const next = diffLines_[i + 1];
        if (next?.kind === "added") {
          pairs.push({ left: cur, right: next });
          i += 2;
        } else {
          pairs.push({ left: cur, right: null });
          i++;
        }
      } else {
        // added without a prior removed
        pairs.push({ left: null, right: cur });
        i++;
      }
    }
    return pairs;
  });
</script>

<div class="file-diff">
  <CollapsibleSection
    label={toolName === "Write" ? "View content" : "View diff"}
    collapsedMaxHeight={400}
    startOpen={true}
    bind:open={expanded}>
    {#if toolName === "Write"}
      <div class="code-block">
        <pre class="block-pre"><code class="shiki-wrap" data-lang={langFromPath(filePath)}>{#if highlightedHtml !== null}{@html highlightedHtml}{:else}{content ?? ""}{/if}</code></pre>
      </div>
    {:else if toolName === "Edit"}
      {#if diffLines_.length === 0}
        <div class="no-diff">No diff available</div>
      {:else}
        <!-- Side-by-side: ≥768px -->
        <div class="diff-side-by-side" aria-label="File diff side by side">
          <div class="diff-column diff-column-old">
            {#each sideBySide as pair}
              <div
                class="diff-row"
                class:diff-removed={pair.left?.kind === "removed"}
                class:diff-unchanged={pair.left?.kind === "unchanged"}
                class:diff-empty={pair.left === null}>
                {#if pair.left}
                  <span class="diff-prefix" aria-hidden="true">{pair.left.kind === "removed" ? "−" : " "}</span><span class="diff-text">{pair.left.text}</span>
                {/if}
              </div>
            {/each}
          </div>
          <div class="diff-column diff-column-new">
            {#each sideBySide as pair}
              <div
                class="diff-row"
                class:diff-added={pair.right?.kind === "added"}
                class:diff-unchanged={pair.right?.kind === "unchanged"}
                class:diff-empty={pair.right === null}>
                {#if pair.right}
                  <span class="diff-prefix" aria-hidden="true">{pair.right.kind === "added" ? "+" : " "}</span><span class="diff-text">{pair.right.text}</span>
                {/if}
              </div>
            {/each}
          </div>
        </div>

        <!-- Unified: <768px -->
        <div class="diff-unified" aria-label="File diff unified">
          {#each diffLines_ as line}
            <div
              class="diff-row"
              class:diff-removed={line.kind === "removed"}
              class:diff-added={line.kind === "added"}
              class:diff-unchanged={line.kind === "unchanged"}>
              <span class="diff-prefix" aria-hidden="true">{line.kind === "removed" ? "−" : line.kind === "added" ? "+" : " "}</span><span class="diff-text">{line.text}</span>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </CollapsibleSection>
</div>

<style>
  .file-diff {
    margin-top: 0.25rem;
  }

  /* Write: code block. The vertical height cap + scroll is owned by the
     wrapping CollapsibleSection (FRI-130, collapsedMaxHeight=400); this pre
     only needs horizontal scroll. */
  .code-block {
    margin-top: 0.35rem;
  }
  .block-pre {
    margin: 0;
    padding: 0.5rem 0.6rem;
    background: var(--bg-code);
    border-radius: var(--radius-sm);
    overflow-x: auto;
  }
  .shiki-wrap {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--text-secondary);
    background: transparent;
    border: none;
    padding: 0;
    white-space: pre;
  }
  /* FRI-124: Shiki is single-theme now. Token spans carry their own
     inline color from the active palette's shikiTheme; the previous
     [data-theme="light/dark"] swap is gone. The wrapper's --text-
     secondary fallback still drives unhighlighted code (lang === "text"
     or pre-Shiki render). */

  /* Edit: diff views */
  .no-diff {
    font-size: 0.78rem;
    color: var(--text-tertiary);
    padding: 0.35rem 0;
    font-style: italic;
  }

  /* Base — mobile defaults */
  .diff-side-by-side {
    display: none;
  }
  .diff-unified {
    display: flex;
    flex-direction: column;
    margin-top: 0.35rem;
    border-radius: var(--radius-sm);
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: 0.78rem;
  }

  /* Desktop ≥768px — swap */
  @media (min-width: 768px) {
    .diff-side-by-side {
      display: flex;
      margin-top: 0.35rem;
      border-radius: var(--radius-sm);
      overflow: hidden;
      font-family: var(--font-mono);
      font-size: 0.78rem;
    }
    .diff-unified {
      display: none;
    }
  }

  .diff-column {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
  }
  .diff-column-old {
    border-right: 1px solid var(--border-subtle);
  }

  .diff-row {
    display: flex;
    align-items: flex-start;
    padding: 0 0.4rem;
    white-space: pre;
    line-height: 1.5;
    min-height: 1.5em;
  }
  .diff-row.diff-removed {
    background: color-mix(in srgb, var(--diff-removed) 15%, transparent);
    color: var(--diff-removed);
  }
  .diff-row.diff-added {
    background: color-mix(in srgb, var(--diff-added) 15%, transparent);
    color: var(--diff-added);
  }
  .diff-row.diff-unchanged {
    background: var(--bg-code);
    color: var(--text-secondary);
  }
  .diff-row.diff-empty {
    background: var(--bg-tertiary);
    opacity: 0.4;
  }

  .diff-prefix {
    width: 1.2em;
    flex-shrink: 0;
    user-select: none;
    font-weight: 700;
  }
  .diff-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
  }
</style>
