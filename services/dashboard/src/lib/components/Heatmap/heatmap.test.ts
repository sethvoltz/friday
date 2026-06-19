import { describe, it, expect } from "vitest";
import { buildHeatmapGrid, isoDay } from "./heatmap";

// A fixed clock so the geometry is deterministic. 2026-06-19 is a Friday.
const NOW = new Date(2026, 5, 19, 14, 30);

describe("buildHeatmapGrid", () => {
  it("renders exactly `weeks` columns", () => {
    expect(buildHeatmapGrid(NOW, 4).numWeeks).toBe(4);
    expect(buildHeatmapGrid(NOW, 26).columns.length).toBe(26);
    expect(buildHeatmapGrid(NOW, 53).columns.length).toBe(53);
  });

  it("never emits a future day; the newest cell is today", () => {
    const today = isoDay(NOW);
    const { columns } = buildHeatmapGrid(NOW, 26);
    const all = columns.flat();
    for (const c of all) expect(c.date <= today).toBe(true);
    // The last cell of the last column is the most recent rendered day.
    const last = columns[columns.length - 1];
    expect(last[last.length - 1].date).toBe(today);
  });

  it("today's cell sits in the row matching its weekday", () => {
    const { columns } = buildHeatmapGrid(NOW, 4);
    const last = columns[columns.length - 1];
    const todayCell = last[last.length - 1];
    expect(todayCell.date).toBe(isoDay(NOW));
    expect(todayCell.row).toBe(NOW.getDay()); // Friday = 5
  });

  it("starts on a Sunday and orders each column Sun→Sat", () => {
    const { columns } = buildHeatmapGrid(NOW, 8);
    // First column is full and begins on Sunday.
    expect(columns[0][0].row).toBe(0);
    for (const col of columns) {
      for (let i = 1; i < col.length; i++) {
        expect(col[i].row).toBeGreaterThan(col[i - 1].row);
        expect(col[i].row).toBeGreaterThanOrEqual(0);
        expect(col[i].row).toBeLessThanOrEqual(6);
      }
    }
  });

  it("places month labels in strictly increasing, in-range columns", () => {
    const { monthLabels, numWeeks } = buildHeatmapGrid(NOW, 53);
    const valid = new Set([
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ]);
    expect(monthLabels.length).toBeGreaterThan(6); // ~a year spans many months
    let prevCol = -1;
    for (const ml of monthLabels) {
      expect(valid.has(ml.text)).toBe(true);
      expect(ml.col).toBeGreaterThan(prevCol); // strictly increasing
      expect(ml.col).toBeGreaterThanOrEqual(0);
      expect(ml.col).toBeLessThan(numWeeks);
      prevCol = ml.col;
    }
  });

  it("never collides adjacent month labels closer than 2 columns", () => {
    const { monthLabels } = buildHeatmapGrid(NOW, 53);
    for (let i = 1; i < monthLabels.length; i++) {
      expect(monthLabels[i].col - monthLabels[i - 1].col).toBeGreaterThanOrEqual(2);
    }
  });
});
