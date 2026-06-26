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
// ADR-049: the typed intent seam (transient status tokens + the user-message
// content view) the dashboard mutators construct and the daemon LISTEN handlers
// parse. Node-free (string consts + JSON), so safe on this browser-bundled
// surface — same contract as schema.ts / model-ids.ts above.
export * from "./intents.js";
export * from "../model-ids.js";
// FRI-142 (ADR-048): re-export the node-free Notification contracts so the
// dashboard's browser bundle can consume the runtime constants
// (DEFAULT_NOTIFY_POLICY, NOTIFY_EVENT_TYPES, CHANNELS, DELIVERY_RULES) +
// types through the client-safe `@friday/shared/sync` surface — importing
// them from the root `@friday/shared` barrel would drag node-only modules
// (db/client → pg, config → node:os) into the page bundle. The module is
// type-only + `const` literals with no `node:*` / `web-push` deps, so it is
// safe here (same browser-safety contract as schema.ts / model-ids.ts).
export * from "../notify/types.js";
