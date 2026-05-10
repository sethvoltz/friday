/**
 * `fetch` with a hard timeout. The default Web `fetch` will hang as long as
 * the TCP connection stays open, which on a slow network or unresponsive
 * daemon means a request can sit pending indefinitely and starve the UI of a
 * "still loading…" / error state.
 *
 * Aborts the underlying request after `timeoutMs` and rejects with an
 * AbortError so callers can render an explicit timeout state.
 */
export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 15_000, signal: callerSignal, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // Compose: if the caller passed their own AbortSignal (route navigation,
  // unmount cleanup), aborting it should also cancel our request.
  if (callerSignal) {
    if (callerSignal.aborted) ctrl.abort();
    else callerSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    return await fetch(input, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
