<script lang="ts">
  import { Tooltip } from "bits-ui";

  interface Props {
    activityByDate: Record<string, { count: number; cost: number }>;
  }

  let { activityByDate }: Props = $props();

  const CELL = 10;
  const GAP = 3;
  const PITCH = CELL + GAP; // 13px per cell slot

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // End on Saturday of this week (so current week is the last column)
  const endDay = new Date(today);
  const todayDow = endDay.getDay(); // 0=Sun
  endDay.setDate(endDay.getDate() + (todayDow === 0 ? 0 : 7 - todayDow)); // roll forward to Sunday

  // Start on the Sunday exactly one year ago (gives 53 columns — a year
  // is 52 weeks + 1-2 days, so we always need a partial first/last column)
  const startDay = new Date(today);
  startDay.setFullYear(startDay.getFullYear() - 1);
  // Roll back to the preceding Sunday
  const startDow = startDay.getDay();
  if (startDow !== 0) startDay.setDate(startDay.getDate() - startDow);

  interface Cell {
    date: string;
    row: number;   // 0=Sun, 1=Mon, ..., 6=Sat
    count: number;
    cost: number;
  }

  // Generate cells and group by week (column)
  interface Week {
    cells: Cell[];
  }

  const { weeks, numWeeks, allCells, nonZero } = $derived.by(() => {
    const weeks: Week[] = [];
    let currentWeek: Cell[] = [];
    const d = new Date(startDay);

    while (d <= endDay) {
      const iso = d.toLocaleDateString("en-CA");
      const jsDow = d.getDay(); // 0=Sun
      const activity = activityByDate[iso];
      const isFuture = d > today;

      if (!isFuture) {
        currentWeek.push({
          date: iso,
          row: jsDow,
          count: activity?.count ?? 0,
          cost: activity?.cost ?? 0,
        });
      }

      // End of week (Saturday = 6) -> push column
      if (jsDow === 6) {
        if (currentWeek.length > 0) {
          weeks.push({ cells: currentWeek });
        }
        currentWeek = [];
      }
      d.setDate(d.getDate() + 1);
    }
    if (currentWeek.length > 0) {
      weeks.push({ cells: currentWeek });
    }

    const numWeeks = weeks.length;
    const allCells = weeks.flatMap((w) => w.cells);
    const nonZero = allCells.map((c) => c.count).filter((c) => c > 0).sort((a, b) => a - b);
    return { weeks, numWeeks, allCells, nonZero };
  });

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

  // Month labels — positioned at the week column where that month first appears
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  interface MonthLabel {
    text: string;
    col: number; // week index
  }

  const monthLabels = $derived.by(() => {
    const labels: MonthLabel[] = [];
    let lastMonth = -1;
    for (let wi = 0; wi < weeks.length; wi++) {
      const firstCell = weeks[wi].cells[0];
      if (!firstCell) continue;
      const month = parseInt(firstCell.date.slice(5, 7), 10) - 1;
      if (month !== lastMonth) {
        let col = wi;
        // Nudge right by one week if this would collide with the previous label
        const prev = labels[labels.length - 1];
        if (prev && col - prev.col < 2) {
          col = col + 1;
        }
        labels.push({ text: monthNames[month], col });
        lastMonth = month;
      }
    }
    return labels;
  });

  // Day labels — GitHub shows Mon/Wed/Fri aligned to rows 1/3/5 (Sun=0)
  const dayLabelRows = [
    { text: "Mon", row: 1 },
    { text: "Wed", row: 3 },
    { text: "Fri", row: 5 },
  ];

  const DAY_LABEL_W = 30; // px
  const gridW = $derived(numWeeks * PITCH - GAP);
  const gridH = 7 * PITCH - GAP;

  function fmtCost(n: number) {
    return `$${n.toFixed(4)}`;
  }

  function fmtDate(iso: string) {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
</script>

<Tooltip.Provider delayDuration={100}>
  <div class="ag-wrap">
    <svg
      width={DAY_LABEL_W + gridW}
      height={18 + gridH}
      viewBox="0 0 {DAY_LABEL_W + gridW} {18 + gridH}"
      class="ag-svg"
    >
      <!-- Month labels -->
      {#each monthLabels as ml}
        <text
          x={DAY_LABEL_W + ml.col * PITCH}
          y={11}
          class="ag-month"
        >{ml.text}</text>
      {/each}

      <!-- Day labels -->
      {#each dayLabelRows as dl}
        <text
          x={DAY_LABEL_W - 6}
          y={18 + dl.row * PITCH + CELL * 0.75}
          text-anchor="end"
          class="ag-day"
        >{dl.text}</text>
      {/each}
    </svg>

    <!-- Cells as positioned divs overlaid on the SVG area -->
    <div class="ag-cells" style="left: {DAY_LABEL_W}px; top: 18px; width: {gridW}px; height: {gridH}px">
      {#each weeks as week, wi}
        {#each week.cells as cell}
          <Tooltip.Root>
            <Tooltip.Trigger
              class="ag-cell level-{getLevel(cell.count)}"
              style="left: {wi * PITCH}px; top: {cell.row * PITCH}px"
            />
            <Tooltip.Portal>
              <Tooltip.Content class="ag-tip" sideOffset={6}>
                {#if cell.count > 0}
                  <span class="ag-tip-stat">{cell.count} {cell.count === 1 ? 'turn' : 'turns'} on {fmtDate(cell.date)}</span>
                {:else}
                  <span class="ag-tip-stat">No turns on {fmtDate(cell.date)}</span>
                {/if}
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        {/each}
      {/each}
    </div>

    <!-- Legend -->
    <div class="ag-legend" style="width: {DAY_LABEL_W + gridW}px">
      <span class="ag-legend-text">Less</span>
      {#each [0, 1, 2, 3, 4] as level}
        <div class="ag-cell level-{level}" style="position: static"></div>
      {/each}
      <span class="ag-legend-text">More</span>
    </div>
  </div>
</Tooltip.Provider>

<style>
  .ag-wrap {
    position: relative;
    overflow-x: auto;
  }

  .ag-svg {
    display: block;
  }

  .ag-month {
    font-size: 10px;
    fill: var(--text-tertiary);
    font-family: var(--font-sans);
  }

  .ag-day {
    font-size: 10px;
    fill: var(--text-tertiary);
    font-family: var(--font-sans);
  }

  .ag-cells {
    position: absolute;
  }

  :global(.ag-cell) {
    position: absolute;
    width: 10px;
    height: 10px;
    border-radius: 2px;
    border: none;
    padding: 0;
    cursor: default;
    appearance: none;
    display: block;
  }

  :global(.ag-cell.level-0) {
    background: var(--grid-empty);
  }

  :global(.ag-cell.level-1) {
    background: var(--grid-l1);
  }

  :global(.ag-cell.level-2) {
    background: var(--grid-l2);
  }

  :global(.ag-cell.level-3) {
    background: var(--grid-l3);
  }

  :global(.ag-cell.level-4) {
    background: var(--grid-l4);
  }

  .ag-legend {
    display: flex;
    align-items: center;
    gap: 3px;
    justify-content: flex-end;
    margin-top: 6px;
  }

  .ag-legend-text {
    font-size: 10px;
    color: var(--text-tertiary);
    padding: 0 3px;
  }

  :global(.ag-tip) {
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
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  :global(.ag-tip-date) {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-primary);
  }

  :global(.ag-tip-stat) {
    font-size: 10px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }
</style>
