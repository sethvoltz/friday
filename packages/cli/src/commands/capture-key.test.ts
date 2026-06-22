/**
 * `friday capture-key` command wiring (FRI-171, ADR-047).
 *
 * These tests exercise the real citty command tree (the same objects
 * `src/index.ts` registers) with the network mocked at the global `fetch`
 * boundary — the only IO the command performs. They pin:
 *   - the command is registered under `capture-key` with create/list/revoke;
 *   - `create` POSTs the label to the dashboard's internal capture-keys route
 *     with the shared-secret header and prints the returned plaintext key
 *     EXACTLY ONCE (plus the "won't be shown again" warning);
 *   - `list` renders one table row per key with the label, prefix and enabled
 *     state, and never prints a secret;
 *   - `revoke <label> --force` resolves the label to an id via the list and
 *     DELETEs that id.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bind the data dir BEFORE importing anything that resolves @friday/shared
// data-dir constants (the daemon-secret path). getDaemonSecret() auto-creates
// the secret file under this tmpdir, so DashboardClient constructs cleanly.
process.env.FRIDAY_DATA_DIR = mkdtempSync(join(tmpdir(), "friday-capture-key-test-"));

const { captureKeyCommand } = await import("./capture-key.js");
const { DAEMON_SECRET_HEADER } = await import("@friday/shared");

type SubKey = "create" | "list" | "revoke";
function sub(name: SubKey) {
  const subCommands = captureKeyCommand.subCommands as Record<
    string,
    { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
  >;
  return subCommands[name]!;
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: FetchCall[];
let responder: (call: FetchCall) => { status?: number; json: unknown };
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls = [];
  responder = () => ({ json: {} });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const call: FetchCall = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const { status = 200, json } = responder(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    } as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  logSpy.mockRestore();
});

function output(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

describe("capture-key command wiring", () => {
  it("registers create/list/revoke under capture-key", () => {
    expect(captureKeyCommand.meta).toMatchObject({ name: "capture-key" });
    const keys = Object.keys(captureKeyCommand.subCommands as Record<string, unknown>);
    expect(keys).toEqual(expect.arrayContaining(["create", "list", "revoke"]));
  });
});

describe("capture-key create", () => {
  it("POSTs the label with the daemon-secret header and prints the plaintext key once", async () => {
    responder = () => ({
      status: 201,
      json: {
        key: "fcap_SECRET_PLAINTEXT_VALUE",
        view: {
          id: "k1",
          name: "watch",
          prefix: "fcap_",
          enabled: true,
          createdAt: "2026-06-21T00:00:00.000Z",
          start: null,
          lastRequest: null,
          expiresAt: null,
        },
      },
    });

    await sub("create").run({ args: { label: "watch" } });

    // Exactly one POST to the internal capture-keys route, secret-headered.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/api/internal/capture-keys");
    expect(calls[0]!.headers[DAEMON_SECRET_HEADER]).toBeTruthy();
    expect(calls[0]!.body).toEqual({ name: "watch" });

    const out = output();
    // Plaintext printed exactly once.
    const occurrences = out.split("fcap_SECRET_PLAINTEXT_VALUE").length - 1;
    expect(occurrences).toBe(1);
    // And the store-now-it-will-not-be-shown-again warning is present.
    expect(out).toMatch(/store this key now/i);
    expect(out).toMatch(/not be shown again/i);
    // Label + prefix surfaced.
    expect(out).toContain("watch");
    expect(out).toContain("fcap_");
  });

  it('defaults the label to "Capture key" when --label is omitted', async () => {
    responder = () => ({
      status: 201,
      json: {
        key: "fcap_ABC",
        view: {
          id: "k2",
          name: "Capture key",
          prefix: "fcap_",
          enabled: true,
          createdAt: "2026-06-21T00:00:00.000Z",
          start: null,
          lastRequest: null,
          expiresAt: null,
        },
      },
    });
    await sub("create").run({ args: {} });
    expect(calls[0]!.body).toEqual({ name: "Capture key" });
  });
});

describe("capture-key list", () => {
  it("renders one row per key with label, prefix, and enabled state and no secret", async () => {
    responder = () => ({
      json: {
        keys: [
          {
            id: "k1",
            name: "watch",
            prefix: "fcap_",
            enabled: true,
            createdAt: "2026-06-01T00:00:00.000Z",
            start: null,
            lastRequest: "2026-06-20T00:00:00.000Z",
            expiresAt: null,
          },
          {
            id: "k2",
            name: "laptop",
            prefix: "fcap_",
            enabled: false,
            createdAt: "2026-06-02T00:00:00.000Z",
            start: null,
            lastRequest: null,
            expiresAt: null,
          },
        ],
      },
    });

    await sub("list").run({ args: {} });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/api/internal/capture-keys");

    const out = output();
    expect(out).toContain("watch");
    expect(out).toContain("laptop");
    // Created dates rendered (YYYY-MM-DD slice).
    expect(out).toContain("2026-06-01");
    expect(out).toContain("2026-06-20"); // last-used for k1
    // Enabled states.
    expect(out).toMatch(/yes/);
    expect(out).toMatch(/no/);
    // No id key ("k1"/"k2") and no secret leaked into the table body.
    expect(out).not.toMatch(/fcap_[A-Z]/); // a plaintext key would have caps after the prefix
  });

  it("prints an empty-state line when there are no keys", async () => {
    responder = () => ({ json: { keys: [] } });
    await sub("list").run({ args: {} });
    expect(output()).toMatch(/no capture keys/i);
  });
});

describe("capture-key revoke", () => {
  it("resolves a label to its id via the list then DELETEs that id", async () => {
    responder = (call) => {
      if (call.method === "GET") {
        return {
          json: {
            keys: [
              {
                id: "key-abc-123",
                name: "watch",
                prefix: "fcap_",
                enabled: true,
                createdAt: "2026-06-01T00:00:00.000Z",
                start: null,
                lastRequest: null,
                expiresAt: null,
              },
            ],
          },
        };
      }
      return { json: { ok: true } };
    };

    await sub("revoke").run({ args: { target: "watch", force: true } });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe("GET");
    const del = calls[1]!;
    expect(del.method).toBe("DELETE");
    expect(del.url).toContain("/api/internal/capture-keys?id=key-abc-123");
    expect(output()).toMatch(/revoked watch/);
  });

  it("accepts a raw id directly", async () => {
    responder = (call) => {
      if (call.method === "GET") {
        return {
          json: {
            keys: [
              {
                id: "key-abc-123",
                name: "watch",
                prefix: "fcap_",
                enabled: true,
                createdAt: "2026-06-01T00:00:00.000Z",
                start: null,
                lastRequest: null,
                expiresAt: null,
              },
            ],
          },
        };
      }
      return { json: { ok: true } };
    };

    await sub("revoke").run({ args: { target: "key-abc-123", force: true } });

    const del = calls[1]!;
    expect(del.method).toBe("DELETE");
    expect(del.url).toContain("id=key-abc-123");
  });
});
