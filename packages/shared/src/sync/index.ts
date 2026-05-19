// Client-safe surface of `@friday/shared/sync`: just the Zero schema
// (mirrored from Drizzle). Importable from browser bundles — no
// `node:*` deps reachable from here.
//
// The HS256 JWT helpers live separately at `@friday/shared/sync/jwt`
// because they `import { createHmac } from "node:crypto"` and would
// blow up Vite's browser bundle if pulled in transitively.

export * from "./schema.js";
