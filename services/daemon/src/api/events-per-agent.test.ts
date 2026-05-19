/**
 * Phase 5 — per-agent SSE channel tests.
 *
 * Pins the `?agent=<name>` filter contract:
 *   - With no query string, the stream carries every event the
 *     daemon publishes (global behavior, legacy contract).
 *   - With `?agent=foo`, only events whose `agent` field equals
 *     `foo` reach the client.
 *   - Events without an `agent` field (connection_established,
 *     app_lifecycle) always pass through — they're daemon-level
 *     signals every client needs to see.
 */

import type { Server } from "node:http";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;
let server: Server;
let port: number;
let eventBus: typeof import("../events/bus.js")["eventBus"];

beforeAll(async () => {
  handle = await createTestDb({ label: "events_per_agent" });
  ({ eventBus } = await import("../events/bus.js"));
  const { startServer } = await import("./server.js");
  server = startServer({ port: 0 });
  await new Promise<void>((resolve) =>
    server.once("listening", () => resolve()),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port assigned");
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.drop();
});

/**
 * Open an SSE stream, collect events for `ms` milliseconds, abort,
 * and return the parsed event objects (excluding the
 * `connection_established` handshake — that's per-connection
 * metadata, not a buffered event).
 */
async function captureEvents(
  url: string,
  ms: number,
): Promise<Array<Record<string, unknown>>> {
  const ctrl = new AbortController();
  const events: Array<Record<string, unknown>> = [];
  const res = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal: ctrl.signal,
  });
  if (!res.ok || !res.body) throw new Error(`SSE fetch ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  const collect = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        // Parse `data:` lines; ignore `id:`/`event:`/comments.
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              const payload = JSON.parse(line.slice(6)) as Record<
                string,
                unknown
              >;
              if (payload.type === "connection_established") continue;
              events.push(payload);
            } catch {
              /* malformed frame */
            }
          }
        }
      }
    }
  })();

  await new Promise((r) => setTimeout(r, ms));
  ctrl.abort();
  await collect.catch(() => {});
  return events;
}

describe("GET /api/events — Phase 5 per-agent filter", () => {
  it("with no `?agent=` query string, every event flows through (legacy global stream)", async () => {
    // Publish three events for different agents before opening.
    eventBus.publish({
      v: 1,
      type: "block_canceled",
      turn_id: "t-a",
      agent: "alpha",
      block_id: "blk-a",
    });
    eventBus.publish({
      v: 1,
      type: "block_canceled",
      turn_id: "t-b",
      agent: "beta",
      block_id: "blk-b",
    });
    eventBus.publish({
      v: 1,
      type: "block_canceled",
      turn_id: "t-c",
      agent: "gamma",
      block_id: "blk-c",
    });
    const events = await captureEvents(
      `http://127.0.0.1:${port}/api/events`,
      400,
    );
    const agents = new Set(
      events
        .filter((e) => e.type === "block_canceled")
        .map((e) => e.agent as string),
    );
    expect(agents.has("alpha")).toBe(true);
    expect(agents.has("beta")).toBe(true);
    expect(agents.has("gamma")).toBe(true);
  });

  it("with `?agent=beta`, only events whose `agent` field equals beta land", async () => {
    eventBus.publish({
      v: 1,
      type: "block_canceled",
      turn_id: "t-alpha-2",
      agent: "alpha",
      block_id: "blk-alpha-2",
    });
    eventBus.publish({
      v: 1,
      type: "block_canceled",
      turn_id: "t-beta-2",
      agent: "beta",
      block_id: "blk-beta-2",
    });
    eventBus.publish({
      v: 1,
      type: "block_canceled",
      turn_id: "t-gamma-2",
      agent: "gamma",
      block_id: "blk-gamma-2",
    });
    const events = await captureEvents(
      `http://127.0.0.1:${port}/api/events?agent=beta`,
      400,
    );
    const cancels = events.filter((e) => e.type === "block_canceled");
    expect(cancels.length).toBeGreaterThan(0);
    const agents = new Set(cancels.map((e) => e.agent as string));
    expect(agents).toEqual(new Set(["beta"]));
  });

  it("events without an `agent` field (app_lifecycle) pass through any filter", async () => {
    // `app_lifecycle` carries `app`, not `agent`. The Phase 5 filter
    // intentionally lets these through so every connected client
    // sees app installs / uninstalls regardless of which agent they
    // happen to be focused on.
    eventBus.publish({
      v: 1,
      type: "app_lifecycle",
      event: "installed",
      app: "test-app",
      version: "1.0.0",
    });
    const events = await captureEvents(
      `http://127.0.0.1:${port}/api/events?agent=beta`,
      400,
    );
    const appEvents = events.filter((e) => e.type === "app_lifecycle");
    expect(appEvents.length).toBeGreaterThan(0);
  });
});
