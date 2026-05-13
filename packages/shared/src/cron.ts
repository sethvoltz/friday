import { CronExpressionParser } from "cron-parser";

export function nextRun(cron: string, from: Date = new Date()): Date | null {
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: from });
    return it.next().toDate();
  } catch {
    return null;
  }
}

/**
 * Compute the next `count` fire times for a cron expression. Used by the
 * Schedules UI's "Next N fires" preview (FIX_FORWARD 6.6). Returns an empty
 * array if the expression is invalid; otherwise an array of length `count`.
 */
export function nextRuns(
  cron: string,
  count: number,
  from: Date = new Date(),
): Date[] {
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: from });
    const out: Date[] = [];
    for (let i = 0; i < count; i++) {
      out.push(it.next().toDate());
    }
    return out;
  } catch {
    return [];
  }
}

export function isValidCron(cron: string): boolean {
  try {
    CronExpressionParser.parse(cron);
    return true;
  } catch {
    return false;
  }
}
