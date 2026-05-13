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

// FIX_FORWARD 5.10: assert any configured public base URL is actually in
// trustedOrigins. Defends against a future refactor that drops the
// push — a misconfigured BetterAuth would silently 403 every sign-in
// from the tunnel, which is the user-facing symptom most likely to be
// blamed on something else.
const PUBLIC_BASE_URL_SOURCES: Array<[string, string | undefined]> = [
  ["config.publicUrl", cfg.publicUrl],
  ["env.BETTER_AUTH_URL", process.env.BETTER_AUTH_URL],
  ["env.PUBLIC_BASE_URL", process.env.PUBLIC_BASE_URL],
];
for (const [source, url] of PUBLIC_BASE_URL_SOURCES) {
  if (!url) continue;
  if (!trustedOrigins.includes(url)) {
    const msg =
      `FATAL: ${source}=${url} is not present in BetterAuth trustedOrigins ` +
      `(${trustedOrigins.join(", ")}). Refusing to start.`;
    // eslint-disable-next-line no-console
    console.error(msg);
    process.exit(1);
  }
}

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
    // FIX_FORWARD 5.6: tighter session lifetime. 7d absolute expiry with a
    // sliding 1d refresh window — a forgotten session times out within a
    // week; an active user's cookie auto-refreshes daily so they don't
    // get logged out mid-task.
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  secret: process.env.BETTER_AUTH_SECRET!,
});
