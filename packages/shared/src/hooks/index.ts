import type {
  HookContextMap,
  HookEvent,
  HookHandler,
  HookResultMap,
} from "./types.js";

export * from "./types.js";

type AnyHandler = HookHandler<HookEvent>;

export interface HooksLogger {
  log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    data?: Record<string, unknown>,
  ): void;
}

const noopLogger: HooksLogger = { log: () => {} };
let logger: HooksLogger = noopLogger;

export function setHooksLogger(next: HooksLogger | null): void {
  logger = next ?? noopLogger;
}

const handlers = new Map<HookEvent, AnyHandler[]>();

export function registerHook<E extends HookEvent>(
  event: E,
  handler: HookHandler<E>,
): () => void {
  const list = handlers.get(event) ?? [];
  list.push(handler as AnyHandler);
  handlers.set(event, list);
  return () => {
    const current = handlers.get(event);
    if (!current) return;
    const idx = current.indexOf(handler as AnyHandler);
    if (idx >= 0) current.splice(idx, 1);
  };
}

export async function runHooks<E extends HookEvent>(
  event: E,
  ctx: HookContextMap[E],
): Promise<HookResultMap[E][]> {
  const list = handlers.get(event);
  if (!list || list.length === 0) return [];
  const results: HookResultMap[E][] = [];
  for (let i = 0; i < list.length; i++) {
    const handler = list[i] as HookHandler<E>;
    try {
      const out = await handler(ctx);
      if (out === undefined || out === null) continue;
      results.push(out);
      if (
        event === "before_tool_call" &&
        (out as HookResultMap["before_tool_call"]).deny !== undefined
      ) {
        return results;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.log("error", "hooks.handler.error", {
        event,
        handlerIndex: i,
        message,
      });
      if (event === "before_tool_call") {
        results.push(
          { deny: { reason: "hook handler error" } } as HookResultMap[E],
        );
        return results;
      }
    }
  }
  return results;
}

export function __resetHooksForTest(): void {
  handlers.clear();
  logger = noopLogger;
}
