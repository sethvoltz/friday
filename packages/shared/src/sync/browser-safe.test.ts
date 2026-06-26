// Static contract test (FRI-16): `@friday/shared/sync` is client-bundled —
// zero.svelte.ts → createMutators is loaded by the dashboard's ROOT layout,
// so every module reachable at runtime from sync/index.ts lands in the
// browser bundle of every page. Vite silently stubs `node:*` builtins to
// empty modules there, which turns a node-only import into a hydration-time
// crash of the whole dashboard (this happened: mutators.ts imported
// `coerceLegacyModelId` from config.ts, whose module top level calls
// `join(homedir(), ".friday")` — `(0, Z.homedir) is not a function` at
// module evaluation in every client chunk). Nothing else in CI catches the
// class: vitest runs in Node (real node:os), `vite build` stubs silently,
// svelte-check passes. This test walks the RUNTIME import graph of the sync
// source (type-only imports are erased by tsc and never bundled) and pins it
// exactly, so any new edge is a deliberate, reviewed decision.

import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SYNC_DIR = dirname(fileURLToPath(import.meta.url));
const ENTRY = "index.ts";

/**
 * Extract the module specifiers a file imports AT RUNTIME. `import type` /
 * `export type` statements are skipped, and a named clause whose specifiers
 * are all inline `type`-marked is skipped too (tsc elides both forms under
 * this repo's `isolatedModules` config, so neither reaches the bundle).
 */
function runtimeImportSpecifiers(filePath: string): string[] {
  const src = readFileSync(filePath, "utf8");
  const specs: string[] = [];
  // Statement-anchored (`^` + m flag) so prose in comments can't match.
  // `[^;]*?` keeps the clause from spanning past a statement boundary.
  const fromRe = /^(?:import|export)\s+(type\s)?([^;]*?)\s*from\s*["']([^"']+)["']/gm;
  for (const m of src.matchAll(fromRe)) {
    const [, typeKeyword, clause, spec] = m;
    if (typeKeyword) continue; // `import type {…}` / `export type {…}` — erased
    const braces = clause.match(/^\{([\s\S]*)\}$/);
    if (braces) {
      const valueSpecifiers = braces[1]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !/^type\s/.test(s));
      if (valueSpecifiers.length === 0) continue; // all inline-`type` — erased
    }
    specs.push(spec);
  }
  // Side-effect imports (`import "…"`) are always runtime.
  for (const m of src.matchAll(/^import\s*["']([^"']+)["']/gm)) {
    specs.push(m[1]);
  }
  return specs;
}

/** BFS the runtime graph from sync/index.ts. Keys are paths relative to
 *  this directory; values are each file's runtime import specifiers. */
function walkRuntimeGraph(): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  const queue = [join(SYNC_DIR, ENTRY)];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const key = relative(SYNC_DIR, file);
    if (key in graph) continue;
    const specs = runtimeImportSpecifiers(file);
    graph[key] = specs;
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue; // external — checked separately
      queue.push(join(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  }
  return graph;
}

describe("@friday/shared/sync browser-safety contract", () => {
  const graph = walkRuntimeGraph();

  it("pins the exact runtime import graph reachable from sync/index.ts", () => {
    expect(graph).toEqual({
      // FRI-142 (ADR-048): `../notify/types.js` is re-exported from the sync
      // barrel so the dashboard's browser bundle can read the Notification
      // runtime constants (DEFAULT_NOTIFY_POLICY, NOTIFY_EVENT_TYPES, CHANNELS,
      // DELIVERY_RULES) through the client-safe `@friday/shared/sync` surface.
      // It is node-free (type-only + `const` literals; no `node:*` / web-push
      // imports), so the no-builtins assertion below still holds.
      // ADR-049: `./intents.js` is re-exported from the sync barrel and
      // imported by mutators.ts so the dashboard constructs the typed intent
      // (INTENT_STATUS tokens + buildUserMessageContent) through the same
      // client-safe surface. It is node-free (string consts + JSON; no `node:*`
      // imports — its own runtime import list is empty below), so the
      // no-builtins assertion still holds.
      "index.ts": [
        "./schema.js",
        "./mutators.js",
        "./intents.js",
        "../model-ids.js",
        "../notify/types.js",
      ],
      "schema.ts": ["@rocicorp/zero"],
      "mutators.ts": ["../model-ids.js", "./intents.js"],
      "intents.ts": [],
      "../model-ids.ts": [],
      "../notify/types.ts": [],
    });
  });

  it("reaches no node builtins and no external dep other than @rocicorp/zero", () => {
    const externals = Object.values(graph)
      .flat()
      .filter((spec) => !spec.startsWith("."));
    const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
    expect(externals.filter((spec) => nodeBuiltins.has(spec))).toEqual([]);
    expect([...new Set(externals)]).toEqual(["@rocicorp/zero"]);
  });
});
