<script lang="ts">
  // Reusable GitHub-contribution-style heatmap calendar. Owns the grid
  // GEOMETRY (week columns, month labels above the columns, Mon/Wed/Fri day
  // labels), the per-cell hover TOOLTIP (bits-ui), and horizontal scroll.
  // It is colour-agnostic: each caller supplies a `resolve(iso, date)` that
  // returns the cell's class/style/tooltip, so the dashboard Activity card
  // (turn-volume ramp) and the habit detail calendar (per-habit hue + missed
  // slashes) share one layout while keeping their own visual language.
  //
  // Cell fill classes are caller-owned — define them as `:global(...)` in the
  // calling component and return their names from `resolve().className`.

  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import { Tooltip } from "bits-ui";
  import { buildHeatmapGrid, type HeatmapCellInfo } from "./heatmap";

  interface Props {
    /** Map a rendered day → its appearance + tooltip. */
    resolve: (iso: string, date: Date) => HeatmapCellInfo;
    now?: Date;
    /** Week columns to render. */
    weeks?: number;
    /** Square edge in px. */
    cellSize?: number;
    /** Gap between squares in px. */
    gap?: number;
    /** Optional legend row rendered under the grid (e.g. Less→More swatches). */
    legend?: Snippet;
    ariaLabel?: string;
  }

  let {
    resolve,
    now = new Date(),
    weeks = 53,
    cellSize = 10,
    gap = 3,
    legend,
    ariaLabel = "Activity heatmap",
  }: Props = $props();

  const PITCH = $derived(cellSize + gap);
  const DAY_LABEL_W = 30;
  const MONTH_BAND = 18;

  const grid = $derived(buildHeatmapGrid(now, weeks));
  const gridW = $derived(grid.numWeeks * PITCH - gap);
  const gridH = $derived(7 * PITCH - gap);

  // Resolve each cell once, keyed alongside its column position.
  const cells = $derived.by(() =>
    grid.columns.flatMap((col, wi) =>
      col.map((cell) => ({
        wi,
        row: cell.row,
        info: resolve(cell.date, new Date(cell.date + "T00:00:00")),
      })),
    ),
  );

  const dayLabelRows = [
    { text: "Mon", row: 1 },
    { text: "Wed", row: 3 },
    { text: "Fri", row: 5 },
  ];

  let scroller = $state<HTMLDivElement>();
  onMount(() => {
    if (scroller && scroller.scrollWidth > scroller.clientWidth) {
      scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth;
    }
  });
</script>

<Tooltip.Provider delayDuration={100}>
  <div class="hm-wrap" bind:this={scroller}>
    <svg
      width={DAY_LABEL_W + gridW}
      height={MONTH_BAND + gridH}
      viewBox="0 0 {DAY_LABEL_W + gridW} {MONTH_BAND + gridH}"
      class="hm-svg"
      role="img"
      aria-label={ariaLabel}
    >
      {#each grid.monthLabels as ml}
        <text x={DAY_LABEL_W + ml.col * PITCH} y={11} class="hm-month"
          >{ml.text}</text
        >
      {/each}
      {#each dayLabelRows as dl}
        <text
          x={DAY_LABEL_W - 6}
          y={MONTH_BAND + dl.row * PITCH + cellSize * 0.75}
          text-anchor="end"
          class="hm-day">{dl.text}</text
        >
      {/each}
    </svg>

    <div
      class="hm-cells"
      style="left: {DAY_LABEL_W}px; top: {MONTH_BAND}px; width: {gridW}px; height: {gridH}px"
    >
      {#each cells as cell (cell.wi + ":" + cell.row)}
        <Tooltip.Root>
          <Tooltip.Trigger
            class="hm-cell {cell.info.className ?? ''}"
            style="left: {cell.wi * PITCH}px; top: {cell.row *
              PITCH}px; width: {cellSize}px; height: {cellSize}px; {cell.info
              .style ?? ''}"
            aria-label={cell.info.tooltip}
          />
          <Tooltip.Portal>
            <Tooltip.Content class="hm-tip" sideOffset={6}>
              {cell.info.tooltip}
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      {/each}
    </div>
  </div>

  {#if legend}
    <div class="hm-legend" style="width: {DAY_LABEL_W + gridW}px">
      {@render legend()}
    </div>
  {/if}
</Tooltip.Provider>

<style>
  .hm-wrap {
    position: relative;
    overflow-x: auto;
  }

  .hm-svg {
    display: block;
  }

  .hm-month,
  .hm-day {
    font-size: 10px;
    fill: var(--text-tertiary);
    font-family: var(--font-sans);
  }

  .hm-cells {
    position: absolute;
  }

  :global(.hm-cell) {
    position: absolute;
    border-radius: 2px;
    /* Reset the default <button> border to keep cells full-fill; callers that
       want an outline use an inset box-shadow (see HabitCalendar). */
    border: 0;
    padding: 0;
    margin: 0;
    appearance: none;
    display: block;
    cursor: default;
    box-sizing: border-box;
  }

  .hm-legend {
    display: flex;
    align-items: center;
    gap: 3px;
    justify-content: flex-end;
    margin-top: 6px;
  }

  :global(.hm-tip) {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    padding: 5px 8px;
    white-space: nowrap;
    z-index: 50;
    box-shadow: var(--shadow-md);
    font-size: 10px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }
</style>
