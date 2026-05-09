import { betterAuth } from "better-auth";
import Database from "better-sqlite3";
import { DB_PATH, ensureFridayEnv, loadConfig } from "@friday/shared";

ensureFridayEnv();
const cfg = loadConfig();

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

const port = cfg.dashboardPort;
const trustedOrigins = [`http://localhost:${port}`];
if (process.env.BETTER_AUTH_URL) {
  trustedOrigins.push(process.env.BETTER_AUTH_URL);
}

export const auth = betterAuth({
  database: db,
  baseURL:
    process.env.BETTER_AUTH_URL ?? `http://localhost:${port}`,
  trustedOrigins,
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    /** Public sign-up is permanently disabled — first account is created via `friday setup`. */
    disableSignUp: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh once a day
  },
  secret: process.env.BETTER_AUTH_SECRET!,
});
