// Client-safe surface of `@friday/shared/sync`: the Zero schema
// (mirrored from Drizzle), the custom mutators, and the browser-safe
// model-id helpers. Importable from browser bundles — no `node:*` deps
// reachable from here (runtime imports only; `import type` is erased).
//
// The HS256 JWT helpers live separately at `@friday/shared/sync/jwt`
// because they `import { createHmac } from "node:crypto"` and would
// blow up Vite's browser bundle if pulled in transitively.

export * from "./schema.js";
export * from "./mutators.js";
export * from "../model-ids.js";
