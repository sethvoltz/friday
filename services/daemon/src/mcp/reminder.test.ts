/**
 * FRI-168 — reminder_create MCP tool, unit-level against a mocked daemonFetch
 * transport. We stub global `fetch` (capturing method + body so the POST shape
 * can be asserted) and drive the registered `reminder_create` handler off the
 * built `friday-reminder` server, mirroring handler-signal.test.ts's
 * `getToolHandler(server, name)` accessor.
 *
 *   AC2 — three-way mutual exclusion over {runAt, cron, dueDate}: anything but
 *         exactly-one returns isError:true and POSTs nothing.
 *   AC3 — the tool description steers the model toward `dueDate`.
 *   AC1 (resolution half) — a `dueDate` resolves to a CONCRETE runAt at the
 *         default reminder hour (09:00 local) before any POST.
 *   AC7 — with an app context, idempotencyKey produces the deterministic
 *         `app:<appId>:<key>` name in the POST body.
 *   AC8 — without an app context, an idempotencyKey is rejected in the MCP
 *         layer (isError, no POST) — the namespace guard lives in the tool.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REMINDER_HOUR } from "@friday/shared";
import { buildReminderServer } from "./reminder.js";

interface ServerLike {
  instance: {
    // The MCP SDK keeps registered tools on `_registeredTools` (private but
    // stable across the pinned SDK versions); the handler + description are
    // exposed on each entry. Same accessor handler-signal.test.ts uses.
    _registeredTools: Record<
      string,
      {
        handler: (args: unknown, extra: unknown) => Promise<unknown>;
        description?: string;
      }
    >;
  };
}

function getToolEntry(server: unknown, toolName: string) {
  const s = server as ServerLike;
  const entry = s.instance._registeredTools[toolName];
  if (!entry) {
    throw new Error(
      `tool ${toolName} not found on server (have: ${Object.keys(s.instance._registeredTools).join(", ")})`,
    );
  }
  return entry;
}

function getToolHandler(
  server: unknown,
  toolName: string,
): (args: unknown, extra: unknown) => Promise<unknown> {
  return getToolEntry(server, toolName).handler;
}

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
const fetchCalls: FetchCall[] = [];

beforeEach(() => {
  fetchCalls.length = 0;
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      fetchCalls.push({ url, method: init?.method ?? "GET", body });
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function server(appId?: string) {
  return buildReminderServer({
    callerName: "kitchen",
    callerType: "bare",
    daemonPort: 7444,
    appId,
  });
}

const ISO = new Date(Date.now() + 3_600_000).toISOString();

describe("reminder_create three-way mutual exclusion (AC2)", () => {
  it("runAt + cron together → isError, no fetch", async () => {
    const cb = getToolHandler(server(), "reminder_create");
    const res = (await cb({ title: "x", runAt: ISO, cron: "0 4 * * *" }, {})) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(fetchCalls.length).toBe(0);
  });

  it("runAt + dueDate together → isError, no fetch", async () => {
    const cb = getToolHandler(server(), "reminder_create");
    const res = (await cb({ title: "x", runAt: ISO, dueDate: "2026-12-24" }, {})) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(fetchCalls.length).toBe(0);
  });

  it("none of {runAt, cron, dueDate} provided → isError, no fetch", async () => {
    const cb = getToolHandler(server(), "reminder_create");
    const res = (await cb({ title: "x" }, {})) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(fetchCalls.length).toBe(0);
  });

  it("cron + dueDate together → isError, no fetch", async () => {
    const cb = getToolHandler(server(), "reminder_create");
    const res = (await cb({ title: "x", cron: "0 4 * * *", dueDate: "2026-12-24" }, {})) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(fetchCalls.length).toBe(0);
  });
});

describe("reminder_create description steers toward dueDate (AC3)", () => {
  it("the registered tool description mentions dueDate", () => {
    const entry = getToolEntry(server(), "reminder_create");
    expect(entry.description).toBeDefined();
    expect(entry.description!).toContain("dueDate");
  });
});

describe("reminder_create dueDate → concrete runAt at default hour (AC1 resolution half)", () => {
  it("resolves a YYYY-MM-DD dueDate to an ISO runAt whose LOCAL hour is DEFAULT_REMINDER_HOUR and whose Y/M/D match", async () => {
    const cb = getToolHandler(server(), "reminder_create");
    // A fixed future calendar day with NO clock time.
    const dueDate = "2026-12-24";
    await cb({ title: "thaw cod", dueDate }, {});

    expect(fetchCalls.length).toBe(1);
    const body = fetchCalls[0]!.body!;
    const runAt = body.runAt as string;
    expect(typeof runAt).toBe("string");
    expect(runAt.length).toBeGreaterThan(0);

    const [y, m, d] = dueDate.split("-").map(Number);
    const local = new Date(runAt);
    expect(local.getHours()).toBe(DEFAULT_REMINDER_HOUR);
    expect(local.getFullYear()).toBe(y);
    expect(local.getMonth()).toBe(m - 1);
    expect(local.getDate()).toBe(d);

    // Exactly the locally-constructed default-hour instant.
    const expected = new Date(y, m - 1, d, DEFAULT_REMINDER_HOUR, 0, 0, 0);
    expect(runAt).toBe(expected.toISOString());
  });
});

describe("reminder_create deterministic app-namespaced name (AC7)", () => {
  it("with appId + idempotencyKey, the POST body.name is app:<appId>:<key>", async () => {
    const cb = getToolHandler(server("kitchen"), "reminder_create");
    await cb({ title: "thaw cod", runAt: ISO, idempotencyKey: "thaw-2026-W21-cod" }, {});

    expect(fetchCalls.length).toBe(1);
    const body = fetchCalls[0]!.body!;
    expect(body.name).toBe("app:kitchen:thaw-2026-W21-cod");
  });
});

describe("reminder_create namespace guard in the MCP layer (AC8)", () => {
  it("without an app context, an idempotencyKey is rejected (isError) and POSTs nothing", async () => {
    const cb = getToolHandler(server(undefined), "reminder_create");
    const res = (await cb({ title: "thaw cod", runAt: ISO, idempotencyKey: "x" }, {})) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(fetchCalls.length).toBe(0);
  });

  it("reminder_create rejects an app:-prefixed name from a non-app caller (FRI-168)", async () => {
    // A non-app caller (appId undefined) must not be able to pass an explicit
    // `app:<id>:<key>` name and clobber an app-owned reminder via the
    // name-keyed upsert. The guard rejects it in the MCP layer, POSTing nothing.
    const cb = getToolHandler(server(undefined), "reminder_create");
    const res = (await cb({ title: "x", runAt: ISO, name: "app:kitchen:thaw" }, {})) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(fetchCalls.length).toBe(0);
  });
});
