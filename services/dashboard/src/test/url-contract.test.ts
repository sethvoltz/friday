/**
 * URL-contract test. Every `fetch("/api/...")` in client code must have
 * a matching `+server.ts` route. Catches the class of regression where
 * a dashboard call site is added without its SvelteKit proxy (or where
 * an endpoint moves and a call site doesn't follow).
 *
 * Approach: walk `routes/api/` to enumerate the routes; build one
 * regex per route by converting `[name]` → `[^/]+`. For each client
 * `fetch` literal, parse the path with the standard `URL` class and
 * compare. The original version of this test hand-rolled a template-
 * literal walker; this one uses one regex substitution and one URL
 * parse and ends up shorter and more readable.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const SRC_DIR = resolve(dirname(__filename), "..");
const ROUTES_DIR = join(SRC_DIR, "routes");
const API_ROUTES_DIR = join(ROUTES_DIR, "api");

function walk(dir: string, pred: (path: string) => boolean): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(cur, name);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile() && pred(p)) out.push(p);
    }
  }
  return out;
}

/** SvelteKit route dir → array of segment matchers. Each segment is one
 *  of:
 *   - `{ kind: "literal", value: "blocks" }`
 *   - `{ kind: "param" }`            // `[name]` — matches one segment
 *   - `{ kind: "rest"  }`            // `[...rest]` — matches any tail
 */
type Seg =
  | { kind: "literal"; value: string }
  | { kind: "param" }
  | { kind: "rest" };

function routeDirToSegments(routeDir: string): Seg[] {
  const rel = routeDir.slice(ROUTES_DIR.length).replace(/^\/+/, "");
  return rel
    .split("/")
    .filter(Boolean)
    .map<Seg>((seg) => {
      if (/^\[\.\.\.[^\]]+\]$/.test(seg)) return { kind: "rest" };
      if (/^\[[^\]]+\]$/.test(seg)) return { kind: "param" };
      return { kind: "literal", value: seg };
    });
}

/**
 * Extract every `fetch("/api/...")` literal from a source file.
 * Template interpolations (`${...}`) are substituted with a `_` wildcard
 * stand-in before parsing; the matcher will treat any `[^/]+` route
 * segment as a match for them. Query strings are dropped via `URL`.
 */
function extractFetchPaths(src: string): { path: string; line: number }[] {
  const out: { path: string; line: number }[] = [];
  const callPat = /\bfetch(?:WithTimeout)?\s*\(\s*([`'"])/g;
  let m: RegExpExecArray | null;
  while ((m = callPat.exec(src)) !== null) {
    const quote = m[1]!;
    const start = m.index + m[0].length;
    // Find the matching closing quote on the same line; bail otherwise.
    const closeIdx = findClosingQuote(src, start, quote);
    if (closeIdx < 0) continue;
    const raw = src.slice(start, closeIdx);
    if (!raw.startsWith("/api/")) continue;
    // Replace template interpolations with a fixed placeholder, then
    // parse via URL to strip any querystring / hash.
    const placeheld = raw.replace(/\$\{[^}]*\}/g, "_PARAM_");
    let path: string;
    try {
      path = new URL(placeheld, "http://x").pathname;
    } catch {
      continue;
    }
    const lineNo = src.slice(0, m.index).split("\n").length;
    out.push({ path, line: lineNo });
  }
  return out;
}

/** Find the matching closing quote starting at `from`, respecting escaped
 *  quotes and balanced `${...}` interpolations inside backticks. */
function findClosingQuote(
  src: string,
  from: number,
  quote: string,
): number {
  let i = from;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") return -1;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i;
    if (c === "$" && src[i + 1] === "{" && quote === "`") {
      // Skip `${...}` with brace-depth tracking.
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return -1;
}

const PARAM_PLACEHOLDER = "_PARAM_";

/**
 * Match a URL path against a route's segment list.
 *
 *   - URL segments equal to `_PARAM_` exactly were template-interpolations
 *     in the source (`${something}`). They match either a route `param`
 *     or a route `literal` — at runtime the interpolated value could
 *     evaluate to either. False negatives on this rule are tolerable;
 *     false positives would block legitimate dynamic patterns.
 *   - URL segments with `_PARAM_` as a *suffix* on a literal prefix
 *     (`links_PARAM_`) are almost always a querystring leak from a
 *     template like `${qs}` that starts with `?`. We compare just the
 *     literal prefix against the route segment.
 */
function urlPathMatchesRoute(urlPath: string, segs: Seg[]): boolean {
  const urlSegs = urlPath.split("/").filter(Boolean);
  // Handle `[...rest]` routes up front.
  const restIdx = segs.findIndex((s) => s.kind === "rest");
  if (restIdx >= 0) {
    // Prefix must match; the rest segment soaks the remainder.
    if (urlSegs.length < restIdx) return false;
    for (let i = 0; i < restIdx; i++) {
      if (!segMatch(urlSegs[i]!, segs[i]!)) return false;
    }
    return true;
  }
  if (urlSegs.length !== segs.length) return false;
  for (let i = 0; i < segs.length; i++) {
    if (!segMatch(urlSegs[i]!, segs[i]!)) return false;
  }
  return true;
}

function segMatch(urlSeg: string, routeSeg: Seg): boolean {
  if (routeSeg.kind === "rest") return true;
  // Strip a trailing `_PARAM_` (querystring leak from `${qs}` where
  // the template included the leading `?`).
  const trimmed =
    urlSeg.endsWith(PARAM_PLACEHOLDER) && urlSeg !== PARAM_PLACEHOLDER
      ? urlSeg.slice(0, -PARAM_PLACEHOLDER.length)
      : urlSeg;
  if (urlSeg === PARAM_PLACEHOLDER) return true; // dynamic — accept either kind
  if (routeSeg.kind === "param") return trimmed.length > 0;
  return trimmed === routeSeg.value;
}

describe("dashboard URL ↔ SvelteKit route contract", () => {
  it("every fetched /api/... has a matching +server.ts", () => {
    const routes = walk(API_ROUTES_DIR, (p) =>
      p.endsWith("+server.ts"),
    ).map((p) => routeDirToSegments(dirname(p)));
    expect(routes.length).toBeGreaterThan(0);

    // Client code only: skip server-side daemon-proxy files (those call
    // the daemon directly, not their own SvelteKit routes) and the
    // shared daemon-fetch helper.
    const sourceFiles = walk(
      SRC_DIR,
      (p) =>
        (p.endsWith(".ts") || p.endsWith(".svelte")) &&
        !p.endsWith(".test.ts") &&
        !p.endsWith(".d.ts") &&
        !p.includes("/test/") &&
        !p.includes("/lib/server/") &&
        !p.includes("/routes/api/"),
    );

    const orphans: { path: string; file: string; line: number }[] = [];
    for (const file of sourceFiles) {
      const src = readFileSync(file, "utf8");
      for (const { path, line } of extractFetchPaths(src)) {
        // BetterAuth handles /api/auth/* itself; no +server.ts.
        if (path.startsWith("/api/auth")) continue;
        if (routes.some((segs) => urlPathMatchesRoute(path, segs))) continue;
        orphans.push({ path, file, line });
      }
    }
    if (orphans.length > 0) {
      const summary = orphans
        .map(
          (o) =>
            `  ${o.path}\n      at ${o.file.replace(SRC_DIR + "/", "")}:${o.line}`,
        )
        .join("\n");
      throw new Error(
        `Found ${orphans.length} fetched URL(s) with no matching SvelteKit route:\n${summary}`,
      );
    }
  });
});
