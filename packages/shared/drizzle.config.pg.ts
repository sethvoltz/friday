// Drizzle config for the Postgres schema (ADR-023).
//
// Used in Phase 0 to generate the Postgres migration set into ./drizzle-pg/
// without disturbing the live SQLite migration chain in ./drizzle/. Phase 1
// replaces the SQLite config with this one and drops the SQLite chain.
//
// Run:
//   pnpm --filter @friday/shared exec drizzle-kit generate --config=drizzle.config.pg.ts

import type { Config } from "drizzle-kit";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://friday:friday@localhost:5432/friday";

export default {
  schema: "./src/db/schema.pg.ts",
  out: "./drizzle-pg",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
} satisfies Config;
