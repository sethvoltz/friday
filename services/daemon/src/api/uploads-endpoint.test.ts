import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDb,
  getDaemonSecret,
  DAEMON_SECRET_HEADER,
  type TestDbHandle,
} from "@friday/shared";

/**
 * Round-trip coverage for the binary uploads routes. These are `raw` rows — the
 * handler owns `req`/`res` (streamed body, computed headers), so the migration
 * had to keep them OUT of the JSON envelope while still carrying the same-host
 * `auth` gate. Pins: 401 without the daemon secret (both POST + GET), the
 * unsupported-mime 415, and a POST→GET byte round-trip with the secret.
 */

// A 1x1 transparent PNG — valid bytes with an allowlisted mime.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==",
  "base64",
);

let handle: TestDbHandle;
let server: Server;
let port: number;
let secret: string;

beforeAll(async () => {
  handle = await createTestDb({ label: "uploads_endpoint" });
  const { startServer } = await import("./server.js");
  server = startServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port assigned");
  port = addr.port;
  secret = getDaemonSecret();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

const base = () => `http://127.0.0.1:${port}`;

describe("uploads routes (raw rows — auth gate + binary)", () => {
  it("POST /api/uploads 401s without the daemon secret", async () => {
    const res = await fetch(`${base()}/api/uploads`, {
      method: "POST",
      headers: { "content-type": "image/png", "x-filename": "x.png" },
      body: PNG_1x1,
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/uploads/<sha> 401s without the daemon secret", async () => {
    const sha = "a".repeat(64);
    const res = await fetch(`${base()}/api/uploads/${sha}`);
    expect(res.status).toBe(401);
  });

  it("POST 415s an unsupported mime even with a valid secret", async () => {
    const res = await fetch(`${base()}/api/uploads`, {
      method: "POST",
      headers: {
        [DAEMON_SECRET_HEADER]: secret,
        "content-type": "application/x-msdownload",
        "x-filename": "evil.exe",
      },
      body: Buffer.from("MZ"),
    });
    expect(res.status).toBe(415);
  });

  it("POST then GET round-trips the bytes through the raw upload/download path", async () => {
    const up = await fetch(`${base()}/api/uploads`, {
      method: "POST",
      headers: {
        [DAEMON_SECRET_HEADER]: secret,
        "content-type": "image/png",
        "x-filename": "pixel.png",
      },
      body: PNG_1x1,
    });
    expect(up.status).toBe(200);
    const meta = (await up.json()) as { sha256: string; mime: string; sizeBytes: number };
    expect(meta.mime).toBe("image/png");
    expect(meta.sizeBytes).toBe(PNG_1x1.length);
    expect(meta.sha256).toMatch(/^[a-f0-9]{64}$/);

    const down = await fetch(`${base()}/api/uploads/${meta.sha256}`, {
      headers: { [DAEMON_SECRET_HEADER]: secret },
    });
    expect(down.status).toBe(200);
    // png is inline-safe → served with its own content-type, not octet-stream.
    expect(down.headers.get("content-type")).toBe("image/png");
    expect(down.headers.get("x-content-type-options")).toBe("nosniff");
    const got = Buffer.from(await down.arrayBuffer());
    expect(got.equals(PNG_1x1)).toBe(true);
  });
});
