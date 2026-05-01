import { createLogger, type LogLevel } from "@friday/shared";

const logger = createLogger({ service: "daemon" });

export function log(
  level: LogLevel,
  event: string,
  data: Record<string, unknown> = {}
): void {
  logger.log(level, event, data);
}

/**
 * Close the log file descriptor. Must be the LAST step of graceful
 * shutdown — any `log()` call after this throws "already closed".
 */
export function closeLog(): void {
  logger.close();
}
