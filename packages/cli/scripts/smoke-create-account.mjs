#!/usr/bin/env node
// Phase 1/2 manual-smoke helper: programmatically create a smoke-test
// account against the live Postgres DB so we can drive the dashboard
// end-to-end without going through the interactive `friday setup` flow.
//
// Usage:
//   node packages/cli/scripts/smoke-create-account.mjs <email> <password>

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { ensureFridayEnv, getDb, schema } from "@friday/shared";

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("usage: smoke-create-account.mjs <email> <password>");
  process.exit(2);
}

ensureFridayEnv();

const db = getDb();

const existing = await db.select().from(schema.users).limit(1);
if (existing.length > 0) {
  console.log(`account already exists: ${existing[0].email}`);
  process.exit(0);
}

const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema, usePlural: true }),
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:5173",
  emailAndPassword: { enabled: true, disableSignUp: false },
  secret: process.env.BETTER_AUTH_SECRET,
});

await auth.api.signUpEmail({
  body: { email, password, name: email.split("@")[0] },
});
console.log(`created account: ${email}`);
process.exit(0);
