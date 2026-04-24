import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startEventServer, stopEventServer } from "./server.js";
import { eventBus } from "./bus.js";
import http from "node:http";

let port: number;

function getRandomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

function httpGet(path: string, headers?: Record<string, string>): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}${path}`, { headers }, resolve);
    req.on("error", reject);
  });
}

function collectSSEEvents(
  path: string,
  count: number,
  headers?: Record<string, string>,
): Promise<{ events: string[]; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}${path}`, { headers }, (res) => {
      const events: string[] = [];
      let buf = "";
      res.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        // Split on double newlines (SSE event boundary)
        const parts = buf.split("\n\n");
        buf = parts.pop()!;
        for (const part of parts) {
          if (part.startsWith(":")) continue; // skip comments
          if (!part.includes("data:")) continue; // skip non-event fields (retry, etc.)
          events.push(part);
          if (events.length >= count) {
            res.destroy();
            resolve({ events, res });
          }
        }
      });
      res.on("error", () => {
        // Connection destroyed after collecting events — expected
        if (events.length >= count) return;
        reject(new Error("Connection closed before collecting enough events"));
      });
    });
    req.on("error", reject);
  });
}

beforeEach(async () => {
  eventBus._reset();
  port = getRandomPort();
  await startEventServer(port);
});

afterEach(async () => {
  await stopEventServer();
});

describe("SSE Server", () => {
  it("serves /health endpoint", async () => {
    const res = await httpGet("/health");
    expect(res.statusCode).toBe(200);
    const body = await new Promise<string>((resolve) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    expect(JSON.parse(body)).toEqual({ ok: true });
  });

  it("returns 404 for unknown paths", async () => {
    const res = await httpGet("/unknown");
    expect(res.statusCode).toBe(404);
  });

  it("streams events via SSE", async () => {
    // Publish after a tiny delay to let client connect
    setTimeout(() => {
      eventBus.publish({ type: "agent:destroyed", agentName: "test-agent" });
    }, 50);

    const { events } = await collectSSEEvents("/events", 1);
    expect(events).toHaveLength(1);

    const lines = events[0].split("\n");
    expect(lines.some((l) => l.startsWith("id:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("event:agent:destroyed"))).toBe(true);
    expect(lines.some((l) => l.startsWith("data:"))).toBe(true);

    const dataLine = lines.find((l) => l.startsWith("data:"))!;
    const payload = JSON.parse(dataLine.replace("data:", ""));
    expect(payload.type).toBe("agent:destroyed");
    expect(payload.agentName).toBe("test-agent");
    expect(payload.seq).toBe(1);
  });

  it("replays events on Last-Event-ID", async () => {
    // Publish 3 events before connecting
    eventBus.publish({ type: "agent:destroyed", agentName: "a" });
    eventBus.publish({ type: "agent:destroyed", agentName: "b" });
    eventBus.publish({ type: "agent:destroyed", agentName: "c" });

    // Connect with Last-Event-ID: 1 — should get events 2 and 3
    const { events } = await collectSSEEvents("/events", 2, {
      "Last-Event-ID": "1",
    });

    expect(events).toHaveLength(2);

    const first = JSON.parse(events[0].split("\n").find((l) => l.startsWith("data:"))!.replace("data:", ""));
    const second = JSON.parse(events[1].split("\n").find((l) => l.startsWith("data:"))!.replace("data:", ""));
    expect(first.seq).toBe(2);
    expect(second.seq).toBe(3);
  });

  it("includes CORS headers", async () => {
    const res = await httpGet("/health");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});
