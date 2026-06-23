/**
 * FRI-142 (ADR-048) — cross-boundary test: a `toast` SSE event must route to
 * the live Toast queue, NOT through `chat.applyEvent`.
 *
 * The bug this pins: a toast carries no `agent`, so if it went through
 * `chat.applyEvent` the chat store's per-agent seq-dedup would bucket it under
 * SYSTEM and (since SYSTEM's seq cursor advances on unrelated events) wrongly
 * drop it. The fix routes `parsed.type === "toast"` to `toasts.push(parsed)`
 * before the `chat.applyEvent` fan-out.
 *
 * We drive the REAL SSE reader loop: a mocked `fetch` returns a single
 * `event: toast` frame over a ReadableStream, `startSSE()` opens the
 * connection, and we assert the observable post-state — the toast landed in
 * `toasts.items` and `chat.applyEvent` was never called with it. This is the
 * SSE↔store boundary, the layer the routing bug lives in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/stores/persistent", () => ({
  loadJSON: vi.fn(() => ({})),
  saveJSON: vi.fn(),
  loadString: vi.fn(() => null),
  saveString: vi.fn(),
  KEYS: { transcript: (agent: string) => `transcript:${agent}` },
}));

vi.mock("$lib/stores/dashboard-data.svelte", () => ({
  bumpDashboardData: vi.fn(),
}));

vi.mock("$lib/stores/connectivity.svelte", () => ({
  connectivity: { markSuccess: vi.fn() },
}));

import { startSSE, stopSSE } from "./sse.svelte";
import { toasts } from "./toast.svelte";
import { chat } from "./chat.svelte";

/** Build a single-shot SSE response body carrying one `toast` event frame. */
function toastFrameResponse(): Response {
  const frame =
    "event: toast\n" +
    "data: " +
    JSON.stringify({
      v: 1,
      seq: 7,
      type: "toast",
      title: "Builder finished",
      body: "seth/fri-142 archived",
      deep_link: "/agents/builder-1",
      event_type: "builder_archive",
      ts: Date.now(),
    }) +
    "\n\n";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame));
      // Leave the stream open (don't close) so the reader parks on the next
      // read — mirrors a live SSE connection. The test tears down via stopSSE.
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

beforeEach(() => {
  toasts.clear();
  // The fetch is fully mocked, so the per-agent vs global URL is irrelevant
  // here — `connect()` reads `chat.focusedAgent` only to build the query
  // string, which our mock ignores. Leave it at its default.
});

afterEach(() => {
  stopSSE();
  toasts.clear();
  vi.restoreAllMocks();
});

describe("FRI-142: toast SSE event routes to the toast queue, not chat", () => {
  it("pushes a parsed toast into toasts.items and never calls chat.applyEvent for it", async () => {
    const applySpy = vi.spyOn(chat, "applyEvent");
    const fetchMock = vi.fn(() => Promise.resolve(toastFrameResponse()));
    vi.stubGlobal("fetch", fetchMock);

    startSSE();

    // Let the connect() promise + reader.read() drain the enqueued frame.
    // A handful of microtask+macrotask turns is enough for the single frame.
    await vi.waitFor(
      () => {
        expect(toasts.items).toHaveLength(1);
      },
      { timeout: 1000, interval: 10 },
    );

    const item = toasts.items[0];
    expect(item).toMatchObject({
      title: "Builder finished",
      body: "seth/fri-142 archived",
      deepLink: "/agents/builder-1",
      eventType: "builder_archive",
      priority: "normal",
    });

    // The cross-boundary guarantee: the toast did NOT go through the chat
    // store's seq-dedup path. (connection_established may legitimately route
    // elsewhere, but no call carried our toast payload.)
    const sawToast = applySpy.mock.calls.some(
      ([evt]) => (evt as { type?: string }).type === "toast",
    );
    expect(sawToast).toBe(false);
  });
});
