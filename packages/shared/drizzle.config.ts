// Drizzle config for Friday's canonical Postgres store (ADR-023).
//
// Run:
//   pnpm --filter @friday/shared exec drizzle-kit generate
//
// To pick up DATABASE_URL from ~/.friday/.env, source it before running
// drizzle-kit, or export DATABASE_URL inline.

import type { Config } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://friday:friday@localhost:5432/friday";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
} satisfies Config;
