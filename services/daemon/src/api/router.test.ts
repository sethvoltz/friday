import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  handleRequest,
  matchRoute,
  type RouteContext,
  type RouteRow,
  type RouterDeps,
} from "./router.js";

/**
 * Unit tests for the deep request adapter. The whole point of the route table
 * is to test the cross-cutting mechanics ONCE here instead of per-route: auth,
 * body-parse, schema-validation, the success path, and the error envelope each
 * get exactly one assertion. Mirrors `intake.test.ts` — fake rows with a vi.fn()
 * handler, but a REAL zod schema so the validation branch genuinely runs.
 */

interface FakeRes {
  res: ServerResponse;
  status(): number | undefined;
  json(): unknown;
}

/** A ServerResponse stand-in that records the writeHead status + the end() body. */
function fakeRes(): FakeRes {
  let status: number | undefined;
  let raw: string | undefined;
  const res = {
    writeHead(s: number) {
      status = s;
      return res;
    },
    end(body?: string) {
      raw = body;
      return res;
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => status,
    json: () => (raw === undefined ? undefined : JSON.parse(raw)),
  };
}

function baseCtx(
  res: ServerResponse,
  opts: { method?: string; path?: string } = {},
): Pick<RouteContext, "req" | "res" | "url" | "path" | "method" | "cfg"> {
  const path = opts.path ?? "/api/thing";
  return {
    req: {} as IncomingMessage,
    res,
    url: new URL(`http://127.0.0.1${path}`),
    path,
    method: opts.method ?? "POST",
    cfg: {} as RouteContext["cfg"],
  };
}

/** Default deps: authorizes everything, parses a fixed body. Overridden per test. */
function deps(over: Partial<RouterDeps> = {}): RouterDeps {
  return {
    authorize: () => true,
    readBody: async () => ({ name: "x" }),
    ...over,
  };
}

describe("matchRoute", () => {
  const rows: RouteRow[] = [
    {
      method: "GET",
      match: "/api/memory/search",
      handler: async () => ({ status: 200, body: "search" }),
    },
    {
      method: "GET",
      match: /^\/api\/memory\/[^/]+$/,
      handler: async () => ({ status: 200, body: "by-id" }),
    },
    {
      method: "POST",
      match: (p) => p.startsWith("/api/elicitation/") && p.endsWith("/submit"),
      handler: async () => ({ status: 200, body: "submit" }),
    },
  ];

  it("matches an exact-string row byte-for-byte (no trailing-slash tolerance)", () => {
    expect(matchRoute(rows, "GET", "/api/memory/search")?.match).toBe("/api/memory/search");
    expect(matchRoute(rows, "GET", "/api/memory/search/")).toBeUndefined();
  });

  it("prefers the specific exact row over the broad regex by declaration order", () => {
    // 'search' must resolve to the exact row, not be read as an entry id.
    const hit = matchRoute(rows, "GET", "/api/memory/search");
    expect(hit?.match).toBe("/api/memory/search");
    // a real id still falls through to the regex row.
    expect(matchRoute(rows, "GET", "/api/memory/abc123")?.match).toBeInstanceOf(RegExp);
  });

  it("supports a predicate matcher (the elicitation prefix+suffix anomaly)", () => {
    expect(matchRoute(rows, "POST", "/api/elicitation/xyz/submit")?.method).toBe("POST");
    expect(matchRoute(rows, "POST", "/api/elicitation/xyz/other")).toBeUndefined();
  });

  it("requires the method to match, not just the path", () => {
    expect(matchRoute(rows, "DELETE", "/api/memory/search")).toBeUndefined();
  });

  it("returns undefined when nothing matches (caller emits 404)", () => {
    expect(matchRoute(rows, "GET", "/api/nope")).toBeUndefined();
  });
});

describe("handleRequest cross-cutting mechanics", () => {
  it("auth failure → 401 envelope, handler never invoked", async () => {
    const f = fakeRes();
    const handler = vi.fn(async () => ({ status: 200, body: "ok" }));
    const row: RouteRow = { method: "POST", match: "/api/thing", auth: true, handler };

    await handleRequest(row, baseCtx(f.res), deps({ authorize: () => false }));

    expect(f.status()).toBe(401);
    expect(f.json()).toEqual({ error: "unauthorized" });
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it("malformed body → one 400 envelope, handler never invoked", async () => {
    const f = fakeRes();
    const handler = vi.fn(async () => ({ status: 201, body: "ok" }));
    const row: RouteRow = { method: "POST", match: "/api/thing", body: "json", handler };

    await handleRequest(
      row,
      baseCtx(f.res),
      deps({
        readBody: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }),
    );

    expect(f.status()).toBe(400);
    expect(f.json()).toEqual({ error: "invalid JSON body" });
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it("validation failure → one 400 envelope naming the offending field, handler never invoked", async () => {
    const f = fakeRes();
    const handler = vi.fn(async () => ({ status: 201, body: "ok" }));
    const schema = z.object({ name: z.string().min(1), mode: z.string() });
    const row: RouteRow = { method: "POST", match: "/api/thing", schema, handler };

    await handleRequest(
      row,
      baseCtx(f.res),
      deps({ readBody: async () => ({ name: "x" }) }), // missing `mode`
    );

    expect(f.status()).toBe(400);
    const body = f.json() as { error: string };
    expect(body.error).toContain("mode");
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it("success → handler result serialized through the one envelope with its status + body", async () => {
    const f = fakeRes();
    const schema = z.object({ name: z.string().min(1) });
    const handler = vi.fn(async (ctx: RouteContext) => ({
      status: 201,
      body: { created: (ctx.body as { name: string }).name },
    }));
    const row: RouteRow = { method: "POST", match: "/api/thing", schema, handler };

    await handleRequest(row, baseCtx(f.res), deps({ readBody: async () => ({ name: "alice" }) }));

    expect(handler).toHaveBeenCalledTimes(1);
    // The handler receives the VALIDATED, typed body (schema.data), not the raw read.
    expect((handler.mock.calls[0][0] as RouteContext).body).toEqual({ name: "alice" });
    expect(f.status()).toBe(201);
    expect(f.json()).toEqual({ created: "alice" });
  });

  it("a handler that returns an explicit non-2xx result passes through unchanged", async () => {
    const f = fakeRes();
    const row: RouteRow = {
      method: "GET",
      match: "/api/thing",
      handler: async () => ({ status: 404, body: { error: "not found" } }),
    };

    await handleRequest(row, baseCtx(f.res, { method: "GET" }), deps());

    expect(f.status()).toBe(404);
    expect(f.json()).toEqual({ error: "not found" });
  });

  it("an uncaught handler throw → centralized 500 envelope with the error message", async () => {
    const f = fakeRes();
    const row: RouteRow = {
      method: "POST",
      match: "/api/thing",
      handler: async () => {
        throw new Error("subsystem exploded");
      },
    };

    await handleRequest(row, baseCtx(f.res), deps());

    expect(f.status()).toBe(500);
    expect(f.json()).toEqual({ error: "subsystem exploded" });
  });

  it("json-optional tolerates a malformed/empty body as {} (mirrors readJson().catch(()=>({})))", async () => {
    const f = fakeRes();
    const handler = vi.fn(async (ctx: RouteContext) => ({ status: 200, body: ctx.body }));
    const row: RouteRow = { method: "POST", match: "/api/thing", body: "json-optional", handler };

    await handleRequest(
      row,
      baseCtx(f.res),
      deps({
        readBody: async () => {
          throw new SyntaxError("empty");
        },
      }),
    );

    expect(f.status()).toBe(200);
    expect(f.json()).toEqual({});
    expect((handler.mock.calls[0][0] as RouteContext).body).toEqual({});
  });

  it("raw rows are gated then handed the connection — no body parse, no serialize", async () => {
    const f = fakeRes();
    const readBody = vi.fn(async () => ({}));
    const raw = vi.fn(async () => {
      /* owns res itself */
    });
    const row: RouteRow = { method: "GET", match: "/api/events", auth: true, raw };

    await handleRequest(row, baseCtx(f.res, { method: "GET" }), deps({ readBody }));

    expect(raw).toHaveBeenCalledTimes(1);
    expect(readBody).toHaveBeenCalledTimes(0); // adapter did NOT parse a body
    expect(f.status()).toBeUndefined(); // adapter did NOT write a response
  });

  it("raw rows still enforce the auth gate before handing off", async () => {
    const f = fakeRes();
    const raw = vi.fn(async () => {});
    const row: RouteRow = { method: "GET", match: "/api/events", auth: true, raw };

    await handleRequest(row, baseCtx(f.res, { method: "GET" }), deps({ authorize: () => false }));

    expect(raw).toHaveBeenCalledTimes(0);
    expect(f.status()).toBe(401);
  });
});
