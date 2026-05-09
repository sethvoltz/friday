import { CronExpressionParser } from "cron-parser";

export function nextRun(cron: string, from: Date = new Date()): Date | null {
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: from });
    return it.next().toDate();
  } catch {
    return null;
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
