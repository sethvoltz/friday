<script lang="ts">
  // Dashboard "turn activity" card. Thin adapter over the reusable
  // HeatmapCalendar: maps each day's turn VOLUME onto a quartile colour ramp
  // (--grid-l1..l4) and a "{n} turns on {date}" tooltip. The grid geometry,
  // month labels, day labels and tooltips all live in HeatmapCalendar.

  import HeatmapCalendar from "$lib/components/Heatmap/HeatmapCalendar.svelte";
  import type { HeatmapCellInfo } from "$lib/components/Heatmap/heatmap";

  interface Props {
    activityByDate: Record<string, { count: number; cost: number }>;
  }

  let { activityByDate }: Props = $props();

  // Quartile thresholds over the non-zero days (activityByDate is already
  // scoped to ~1 year server-side, matching the rendered window).
  const nonZero = $derived(
    Object.values(activityByDate)
      .map((a) => a.count)
      .filter((c) => c > 0)
      .sort((a, b) => a - b),
  );

  function getLevel(count: number): number {
    if (count === 0 || nonZero.length === 0) return 0;
    const q1 = nonZero[Math.floor(nonZero.length * 0.25)];
    const q2 = nonZero[Math.floor(nonZero.length * 0.5)];
    const q3 = nonZero[Math.floor(nonZero.length * 0.75)];
    if (count <= q1) return 1;
    if (count <= q2) return 2;
    if (count <= q3) return 3;
    return 4;
  }

  function fmtDate(iso: string): string {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  function resolve(iso: string): HeatmapCellInfo {
    const count = activityByDate[iso]?.count ?? 0;
    const tooltip =
      count > 0
        ? `${count} ${count === 1 ? "turn" : "turns"} on ${fmtDate(iso)}`
        : `No turns on ${fmtDate(iso)}`;
    return { className: `hm-level-${getLevel(count)}`, tooltip };
  }
</script>

<HeatmapCalendar {resolve} ariaLabel="Turn activity over the last year">
  {#snippet legend()}
    <span class="hm-legend-text">Less</span>
    {#each [0, 1, 2, 3, 4] as level}
      <span class="hm-swatch hm-level-{level}"></span>
    {/each}
    <span class="hm-legend-text">More</span>
  {/snippet}
</HeatmapCalendar>

<style>
  /* Cell + legend-swatch fills — global so they reach the cells rendered
     inside HeatmapCalendar. */
  :global(.hm-level-0) {
    background: var(--grid-empty);
  }
  :global(.hm-level-1) {
    background: var(--grid-l1);
  }
  :global(.hm-level-2) {
    background: var(--grid-l2);
  }
  :global(.hm-level-3) {
    background: var(--grid-l3);
  }
  :global(.hm-level-4) {
    background: var(--grid-l4);
  }

  .hm-swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    display: inline-block;
  }

  .hm-legend-text {
    font-size: 10px;
    color: var(--text-tertiary);
    padding: 0 3px;
  }
</style>
