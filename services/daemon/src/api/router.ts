/**
 * Deep request adapter + route table for the daemon HTTP tier.
 *
 * Before this, `server.ts`'s `handle()` was a hand-written if/else cascade of
 * ~83 branches, each re-implementing the same shell: read the body, validate
 * required fields, call a subsystem, shape an ad-hoc `{ error }` envelope, and
 * pick a status. The cross-cutting mechanics were copy-pasted per branch.
 *
 * This module concentrates that shell in ONE place. A {@link RouteRow} is a
 * declarative data row — `(method, match) → { auth?, schema?, handler }` — and
 * {@link handleRequest} owns the mechanics every route shares, in order:
 *
 *   1. auth gate     — if `row.auth`, run the injected `authorize`; 401 on fail.
 *   2. body parse    — for json rows, drain + JSON.parse via injected `readBody`;
 *                      a malformed body becomes ONE shaped 400 (previously an
 *                      uncaught throw out of `readJson`).
 *   3. schema check  — if `row.schema`, `safeParse` the body; a failure becomes
 *                      ONE shaped 400 naming the offending field(s).
 *   4. handler       — call `row.handler(ctx)` with the validated, typed body.
 *   5. error envelope— a single try/catch maps an uncaught throw to one 500
 *                      `{ error }`, replacing the per-branch
 *                      `err instanceof Error ? err.message : String(err)` idiom.
 *
 * Handlers return DATA (`{ status, body }`); the adapter — not the handler —
 * serializes through {@link writeJson}. Streaming/binary routes (SSE, uploads)
 * and the ADR-036 evolve-scan seam opt out via `raw`: their handler owns `req`
 * and `res` for the connection lifetime and the adapter neither parses a body
 * nor serializes a return value for them.
 *
 * The structural-schema contract (`{ safeParse }` / {@link SafeParseResult}) is
 * deliberately the same producer-agnostic shape the Inbox route-registry uses
 * (`inbox/route-registry.ts`) — author schemas as zod `.object({...})`, type the
 * field as the minimal `safeParse` contract so the router never imports zod's
 * full surface.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import type { loadConfig } from "@friday/shared";

/** The daemon config object threaded through every request. */
export type DaemonConfig = ReturnType<typeof loadConfig>;

/** The shape zod's `safeParse` returns (so the router never imports zod). */
export type SafeParseResult =
  | { success: true; data: unknown }
  | { success: false; error: { message: string } };

/** Minimal structural validator a row carries — satisfied by any zod schema. */
export interface RouteSchema {
  safeParse: (data: unknown) => SafeParseResult;
}

/** What a JSON handler receives: the request primitives plus the parsed body. */
export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** `url.pathname` — query already stripped (preserves today's `path` semantics). */
  path: string;
  method: string;
  cfg: DaemonConfig;
  /**
   * Parsed JSON body for `body: "json"`/`"json-optional"` rows (the validated,
   * typed value when the row carried a `schema`), or `undefined` for body-less
   * rows. Handlers extract dynamic path segments from {@link path} exactly as
   * the cascade did (`path.split("/")[n]` + `decodeURIComponent`).
   */
  body: unknown;
}

/** A JSON route returns data; the adapter serializes it through `writeJson`. */
export type RouteResult = { status: number; body: unknown };

export type RouteHandler = (ctx: RouteContext) => RouteResult | Promise<RouteResult>;

/**
 * A `raw` handler owns `req`/`res` directly — SSE streams, binary upload/
 * download, and the ADR-036 evolve-scan seam. The adapter runs the auth gate
 * (if any) and then hands off completely: no body parse, no return serialize.
 */
export type RawRouteHandler = (
  ctx: Pick<RouteContext, "req" | "res" | "url" | "path" | "method" | "cfg">,
) => void | Promise<void>;

/**
 * How a row matches a request path. Exact string is byte-for-byte `===` (no
 * trailing-slash tolerance — `/api/habits/` does NOT match `/api/habits`). A
 * RegExp matches via `.test(path)`. A predicate covers the one prefix+suffix
 * route (`/api/elicitation/<id>/submit`) that is neither. Declaration order is
 * load-bearing: specific routes must precede the broader regexes that would
 * otherwise swallow them, exactly as the cascade ordered them.
 */
export type RouteMatch = string | RegExp | ((path: string) => boolean);

export interface RouteRow {
  method: string;
  match: RouteMatch;
  /** Gate through `authorize` before the handler runs. Default: false (the
   *  route relies on the 127.0.0.1 binding + injected daemon secret instead).
   *  Carry each route's CURRENT gate faithfully — the split is per-route. */
  auth?: boolean;
  /** Body handling. "json" parses + 400s on malformed; "json-optional" tolerates
   *  an empty/malformed body as `{}` (mirrors `readJson(req).catch(() => ({}))`);
   *  omitted/"none" parses nothing. A `schema` implies "json". */
  body?: "json" | "json-optional" | "none";
  /** Optional payload validator. Present ⇒ body is parsed + validated; the
   *  handler receives the validated value as `ctx.body`. */
  schema?: RouteSchema;
  /** JSON handler: returns `{ status, body }`; the adapter serializes it. */
  handler?: RouteHandler;
  /** Escape hatch for streaming/binary/seam routes that own `req`/`res`. */
  raw?: RawRouteHandler;
}

/** IO the adapter depends on, injected so `handleRequest` is unit-testable with
 *  fakes (mirrors how `dispatchVerdict` takes its targets as a param). */
export interface RouterDeps {
  /** Same-host authorization (loopback Host + constant-time secret compare). */
  authorize: (req: IncomingMessage) => boolean;
  /** Drain the request body and `JSON.parse` it; throws on malformed JSON. */
  readBody: (req: IncomingMessage) => Promise<unknown>;
}

/** Write a buffered JSON response. The single response primitive the adapter
 *  serializes every non-raw handler result through. */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Find the first row whose method AND match accept `(method, path)`, in
 * DECLARATION ORDER. Order is the only disambiguator for the specific-before-
 * broad regex cases, so the table must list them in the cascade's original
 * order. Returns `undefined` on no match (the caller emits the 404).
 */
export function matchRoute(
  rows: readonly RouteRow[],
  method: string,
  path: string,
): RouteRow | undefined {
  for (const row of rows) {
    if (row.method !== method) continue;
    if (matchesPath(row.match, path)) return row;
  }
  return undefined;
}

function matchesPath(match: RouteMatch, path: string): boolean {
  if (typeof match === "string") return match === path;
  if (typeof match === "function") return match(path);
  return match.test(path);
}

/**
 * Run one matched row through the shared mechanics. Owns auth → parse → validate
 * → handler → error-envelope. `raw` rows skip parse + serialize after the auth
 * gate. `base` carries the request primitives; the adapter fills in `body`.
 */
export async function handleRequest(
  row: RouteRow,
  base: Pick<RouteContext, "req" | "res" | "url" | "path" | "method" | "cfg">,
  deps: RouterDeps,
): Promise<void> {
  const { req, res } = base;

  // 1. Auth gate — identical 401 envelope for every gated route.
  if (row.auth && !deps.authorize(req)) {
    writeJson(res, 401, { error: "unauthorized" });
    return;
  }

  // raw rows own the connection: hand off after the auth gate.
  if (row.raw) {
    await row.raw(base);
    return;
  }

  if (!row.handler) {
    // Misconfigured row — a programming error, surfaced loudly.
    writeJson(res, 500, { error: "route has no handler" });
    return;
  }

  // 2. Body parse — one shaped 400 for a malformed body (was an uncaught throw).
  const wantsBody = row.body === "json" || row.body === "json-optional" || row.schema != null;
  let body: unknown;
  if (wantsBody) {
    try {
      body = await deps.readBody(req);
    } catch {
      if (row.body === "json-optional") {
        body = {};
      } else {
        writeJson(res, 400, { error: "invalid JSON body" });
        return;
      }
    }
  }

  // 3. Schema validation — one shaped 400 naming the offending field(s).
  if (row.schema) {
    const parsed = row.schema.safeParse(body);
    if (!parsed.success) {
      writeJson(res, 400, { error: parsed.error.message });
      return;
    }
    body = parsed.data;
  }

  // 4 + 5. Handler invocation under one error envelope. Handlers may still
  // return explicit non-2xx results (404/409/415) as structured values; an
  // UNCAUGHT throw is the only thing that becomes the centralized 500.
  try {
    const result = await row.handler({ ...base, body });
    writeJson(res, result.status, result.body);
  } catch (err) {
    writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
