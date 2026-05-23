import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  ensureFridayEnv,
  getDb,
  loadConfig,
  PROD_DASHBOARD_PORT,
  resolveDashboardPort,
  schema,
} from "@friday/shared";

ensureFridayEnv();
const cfg = loadConfig();

const db = getDb();

const resolvedPort = resolveDashboardPort(cfg);
// `localUrl` is the canonical localhost origin for THIS process — used
// as the BetterAuth baseURL fallback when no public URL is configured.
const localUrl = `http://localhost:${resolvedPort}`;

// trustedOrigins gates BetterAuth's CSRF check (Origin header must match).
// The list is intentionally permissive on localhost:
// - http://localhost:7615 (prod dashboard, PROD_DASHBOARD_PORT)
// - http://localhost:5173 (vite dev, the contributor wrapper)
// - http://localhost:<resolvedPort> if the user overrode `cfg.dashboardPort`
//   to something other than the two well-known values
// - cfg.publicUrl (the Cloudflare Tunnel hostname, for phone / remote access)
// - process.env.BETTER_AUTH_URL (explicit override for unusual setups)
//
// Both localhost ports are listed unconditionally so a developer can
// sign in on the dev origin (`:5173`) without the prod dashboard having
// to know about dev's port — same shape from the operator's view, no
// per-environment branching.
const DEV_DASHBOARD_LOCAL = "http://localhost:5173";
const PROD_DASHBOARD_LOCAL = `http://localhost:${PROD_DASHBOARD_PORT}`;
const trustedOrigins: string[] = [PROD_DASHBOARD_LOCAL, DEV_DASHBOARD_LOCAL];
if (resolvedPort !== PROD_DASHBOARD_PORT && localUrl !== DEV_DASHBOARD_LOCAL) {
  trustedOrigins.push(localUrl);
}
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
  // Our schema exports keys with plural names (`users`, `sessions`,
  // `accounts`, `verifications`) while the physical pg tables use
  // BetterAuth's expected singular names. `usePlural: true` aligns the
  // adapter's lookups with our schema's exported symbol names.
  database: drizzleAdapter(db, { provider: "pg", schema, usePlural: true }),
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
