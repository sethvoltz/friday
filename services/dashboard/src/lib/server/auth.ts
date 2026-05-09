import { betterAuth } from "better-auth";
import Database from "better-sqlite3";
import { DB_PATH, ensureFridayEnv, loadConfig } from "@friday/shared";

ensureFridayEnv();
const cfg = loadConfig();

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

const port = cfg.dashboardPort;
const localUrl = `http://localhost:${port}`;

// trustedOrigins gates BetterAuth's CSRF check (Origin header must match).
// We accept localhost (laptop access) plus the public Cloudflare Tunnel
// URL when configured (phone / remote access). BETTER_AUTH_URL stays as
// an explicit override for unusual setups.
const trustedOrigins = [localUrl];
if (cfg.publicUrl) trustedOrigins.push(cfg.publicUrl);
if (process.env.BETTER_AUTH_URL) trustedOrigins.push(process.env.BETTER_AUTH_URL);

// baseURL is what BetterAuth uses to generate absolute URLs (cookies,
// redirects). When a tunnel is configured, prefer the public HTTPS URL —
// otherwise BetterAuth would emit `http://localhost` URLs that browsers
// reject as mixed content on the secure page.
const baseURL = process.env.BETTER_AUTH_URL ?? cfg.publicUrl ?? localUrl;

export const auth = betterAuth({
  database: db,
  baseURL,
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
