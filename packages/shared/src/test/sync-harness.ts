/**
 * Multi-subprocess e2e test harness for the Postgres + Zero sync
 * surface (item #50 in `~/.claude/plans/mellow-sparking-dusk.md`).
 *
 * # API
 *
 * `spawnTestSyncEnv(opts)` → `SyncEnv` — composes a full Friday
 * environment in 3-5s and tears it back down on `.cleanup()`. Each
 * call gets:
 *
 *   - A fresh `friday_test_<label>_<hex>` scratch Postgres database
 *     (via `@friday/shared`'s `createTestDb`). All migrations applied.
 *   - A zero-cache subprocess on a free port, with its own SQLite
 *     replica in a per-env tmpdir. Bound to the scratch DB as its
 *     upstream + the dashboard subprocess as its `ZERO_MUTATE_URL`.
 *   - A daemon subprocess on a free port, with FRIDAY_DATA_DIR
 *     pointing at a per-env tmpdir. Runs migrations + LISTEN
 *     handlers normally.
 *   - A dashboard subprocess on a free port, with BETTER_AUTH_URL
 *     + ZERO_AUTH_SECRET wired to match. Serves real auth via
 *     BetterAuth + real mutator dispatch via PushProcessor.
 *   - `env.mintCookie({ email, name })` — seeds a user + credential
 *     account in the scratch DB, then POSTs `/api/auth/sign-in/email`
 *     against the live dashboard to receive a signed Set-Cookie. By
 *     construction the cookie is one BetterAuth will accept on
 *     subsequent `/api/*` calls.
 *
 * `SyncEnv.cleanup()` SIGTERMs every subprocess (process-group
 * signaling — zero-cache forks 10+ workers we have to reap), drops
 * the upstream replication slot zero-cache leaves behind, and
 * drops the scratch DB.
 *
 * # Skip flags
 *
 * `skipDashboard / skipDaemon / skipZeroCache` opts let lighter-
 * weight tests (pure PG trigger tests; daemon-only stress) skip the
 * subprocess boot. The corresponding handle in the returned env is
 * `null` cast to its type — don't dereference what you skipped.
 *
 * # Suites built on top
 *
 *   - `packages/shared/src/test/sync-harness.e2e.test.ts` — smoke.
 *   - `packages/shared/src/sync/unread-count-trigger.test.ts` — pure
 *     PG trigger test using `skipDashboard / skipDaemon / skipZeroCache`.
 *   - `services/daemon/src/agent/daemon-down.e2e.test.ts` — restart
 *     resilience + boot-recovery contract.
 *   - `services/daemon/src/agent/dispatch-stress.e2e.test.ts` —
 *     exactly-once dispatch under 100-row burst.
 *   - `services/dashboard/src/lib/sync/dashboard-down.e2e.test.ts` —
 *     dashboard restart contract.
 *   - `services/dashboard/e2e/live-typing.spec.ts` — Playwright
 *     browser-driven round-trip; uses this harness via
 *     `e2e/global-setup.ts`.
 *
 * # Lifecycle pattern
 *
 *   beforeAll(() => { env = await spawnTestSyncEnv({ label: "..." }); })
 *   afterAll(()  => { await env.cleanup(); })
 *
 * One env per test file. Tests inside the file share the env and
 * either use unique block ids / agent names per-test or call
 * `env.db.truncate()` between tests to avoid cross-pollution.
 *
 * # Note on the dropped convergence suite
 *
 * The original plan included a synthetic two-`@rocicorp/zero`-clients
 * convergence test. That was dropped: Zero's Node client closes WS
 * with code 1006 against the harness's zero-cache and the dashboard
 * repo has no precedent for a real Node Zero client (every existing
 * `zero.test.ts` mocks the module). The user-visible convergence
 * contract is now covered end-to-end by the Playwright suite —
 * which exercises a real browser Zero client through the same
 * harness, which is what actually matters for Friday's reliability.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createTestDb, type TestDbHandle } from "../db/test-pg.js";

// ─────────────────────────────────────────────────────────────────────
// Repo-root resolution. The harness lives at
// packages/shared/src/test/sync-harness.ts → repo root is ../../../..
// from this file. Used to locate daemon/dashboard build artifacts +
// zero-cache binary in node_modules.
// ─────────────────────────────────────────────────────────────────────

const __dirname_local = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname_local, "..", "..", "..", "..");
const DAEMON_ENTRY = join(REPO_ROOT, "services/daemon/dist/index.js");
const DASHBOARD_DIR = join(REPO_ROOT, "services/dashboard");
const DASHBOARD_ENTRY = join(DASHBOARD_DIR, "server-entry.mjs");

// ─────────────────────────────────────────────────────────────────────
// Free-port allocation. listen(0) → kernel picks an unused port; close
// immediately and reuse the number. Race-prone in theory but acceptable
// for test isolation given vitest's --no-file-parallelism (set in the
// e2e script).
// ─────────────────────────────────────────────────────────────────────

export async function freePort(): Promise<number> {
  return new Promise<number>((res, rej) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        srv.close(() => res(p));
      } else {
        srv.close();
        rej(new Error("listen(0) returned non-AddressInfo"));
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// TCP readiness probe. Polls a connect attempt every 100ms up to a
// timeout. Used as the "is the subprocess listening yet" gate for every
// spawner — simpler and more general than parsing log lines.
// ─────────────────────────────────────────────────────────────────────

export async function waitForTcp(
  port: number,
  opts: { timeoutMs?: number; host?: string } = {},
): Promise<void> {
  const host = opts.host ?? "127.0.0.1";
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((res) => {
      const sock = net.connect(port, host);
      const cleanup = (v: boolean) => {
        sock.removeAllListeners();
        sock.destroy();
        res(v);
      };
      sock.once("connect", () => cleanup(true));
      sock.once("error", () => cleanup(false));
      setTimeout(() => cleanup(false), 500);
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitForTcp: ${host}:${port} did not accept connections within ${timeoutMs}ms`);
}

// ─────────────────────────────────────────────────────────────────────
// Subprocess spawners. Each returns { child, port, ... } + signals the
// `child` exited on cleanup. SIGTERM first; SIGKILL after 1.5s if the
// child hasn't died.
// ─────────────────────────────────────────────────────────────────────

/**
 * SIGTERM the process group; SIGKILL it if not gone in `ms` ms.
 *
 * zero-cache forks 10+ worker subprocesses (runner, change-streamer,
 * replicator, syncers, write-worker, reaper). A plain `child.kill()`
 * only signals the immediate spawn — the workers survive, hold ports,
 * lock the SQLite replica, and stall the next test's spawn with
 * EADDRINUSE / file-busy. Spawning with `detached: true` puts every
 * descendant in the child's process group; `process.kill(-pid, sig)`
 * delivers the signal to the whole group.
 */
async function sigtermThenSigkill(child: ChildProcess, ms = 1_500): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  const pid = child.pid;
  const sigGroup = (signal: NodeJS.Signals) => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal); // negative pid → process group
    } catch {
      // The group may already be gone, or the platform may not
      // support negative pid signaling; fall back to direct child.
      try {
        child.kill(signal);
      } catch {
        /* already dead */
      }
    }
  };
  sigGroup("SIGTERM");
  await Promise.race([
    new Promise<void>((res) => child.once("exit", () => res())),
    new Promise<void>((res) =>
      setTimeout(() => {
        sigGroup("SIGKILL");
        res();
      }, ms),
    ),
  ]);
}

export interface ZeroCacheHandle {
  port: number;
  child: ChildProcess;
  replicaFile: string;
  /** Resolves when zero-cache has logged its first "Replicating" event
   *  OR when its TCP port accepts a connection — whichever comes first. */
  ready: Promise<void>;
}

export interface SpawnZeroCacheOpts {
  databaseUrl: string;
  authSecret: string;
  adminPassword: string;
  /** Optional explicit port; defaults to a free port. */
  port?: number;
  /** Tmpdir parent for the replica file. Defaults to os.tmpdir(). */
  tmpRoot?: string;
  /** Dashboard's `/api/mutators` URL. Zero 1.5+ requires this on
   *  zero-cache (not just the dashboard) so its push processor knows
   *  where to dispatch server-side mutator runs. Without it the
   *  client sees `InvalidPush: A ZERO_MUTATE_URL must be set in
   *  order to process custom mutations.` from zero-cache. */
  mutateUrl?: string;
}

export async function spawnZeroCacheForTest(opts: SpawnZeroCacheOpts): Promise<ZeroCacheHandle> {
  const port = opts.port ?? (await freePort());
  // Each test gets its own SQLite replica file — sharing one across
  // tests would let stale logical-replication state leak between
  // scratch databases.
  const tmpDir = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "zero-cache-"));
  const replicaFile = join(tmpDir, "replica.db");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ZERO_UPSTREAM_DB: opts.databaseUrl,
    ZERO_REPLICA_FILE: replicaFile,
    ZERO_AUTH_SECRET: opts.authSecret,
    ZERO_ADMIN_PASSWORD: opts.adminPassword,
    ZERO_APP_PUBLICATIONS: "friday_pub",
    ZERO_LOG_LEVEL: "warn",
    ZERO_PORT: String(port),
  };
  if (opts.mutateUrl) env.ZERO_MUTATE_URL = opts.mutateUrl;
  const child = spawn("pnpm", ["exec", "zero-cache"], {
    cwd: DASHBOARD_DIR,
    env,
    // `detached: true` lifts the spawn into its own process group so
    // the SIGTERM in cleanup reaches every worker zero-cache forks
    // (runner, syncers, replicator, write-worker, reaper). Without it,
    // workers leak between tests and the next harness boot hits
    // EADDRINUSE on the previously-allocated port.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  if (process.env.FRIDAY_TEST_DEBUG === "1") {
    child.stdout?.on("data", (d) => process.stderr.write(`[zero stdout] ${d}`));
    child.stderr?.on("data", (d) => process.stderr.write(`[zero stderr] ${d}`));
  } else {
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
  }
  // Open TCP isn't enough: zero-cache binds early but rejects the WS
  // upgrade until its syncer workers finish their initial CVR install
  // (~10-60s on a cold tmp filesystem). Probe with the actual Zero
  // sync URL — when the server responds with a 101 Upgrade or any
  // valid HTTP status (4xx is fine; means it accepted the request),
  // we know clients can connect.
  const ready = (async () => {
    await waitForTcp(port, { timeoutMs: 90_000 });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const ok = await new Promise<boolean>((resolve) => {
        const ws = new globalThis.WebSocket(`ws://127.0.0.1:${port}/sync/v50/connect`);
        const settle = (v: boolean) => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          resolve(v);
        };
        ws.onopen = () => settle(true);
        ws.onclose = (ev) => {
          // Zero may close with 1002 / 1006 right after handshake if
          // we send no auth; that's still proof the WS endpoint is
          // alive. A clean refusal (TCP RST during handshake) shows
          // up as a connect-time error event, NOT a close, so a
          // close event here means the server reached the protocol
          // negotiation step.
          settle(ev.code > 0);
        };
        ws.onerror = () => settle(false);
        setTimeout(() => settle(false), 2_000);
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`zero-cache WS upgrade on :${port} didn't succeed within 90s`);
  })();
  return { port, child, replicaFile, ready };
}

export interface DaemonHandle {
  port: number;
  child: ChildProcess;
  /** Per-test FRIDAY_DATA_DIR — config.json + secrets are scoped here. */
  dataDir: string;
  ready: Promise<void>;
}

export interface SpawnDaemonOpts {
  databaseUrl: string;
  /** Port the daemon listens on. */
  port?: number;
  /** Tmpdir parent for FRIDAY_DATA_DIR. */
  tmpRoot?: string;
  /** Pre-generated daemon secret (so the dashboard subprocess can
   *  read the same value). If omitted a fresh secret is generated. */
  daemonSecret?: string;
  /** Existing data dir to reuse (e.g., across a daemon-down restart
   *  test where the daemon's state must persist). When omitted a fresh
   *  one is created. */
  dataDir?: string;
}

export async function spawnDaemonForTest(opts: SpawnDaemonOpts): Promise<DaemonHandle> {
  const port = opts.port ?? (await freePort());
  const dataDir = opts.dataDir ?? mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "friday-daemon-"));
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  // Write the daemon config: pin daemonPort + dashboardPort (we'll
  // overwrite dashboardPort in the dashboard spawner if needed).
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({ daemonPort: port, dashboardPort: 0 }, null, 2),
  );
  // Daemon secret — random per-test unless provided. The dashboard
  // subprocess reads the same file via FRIDAY_DATA_DIR.
  if (!opts.daemonSecret) {
    writeFileSync(join(dataDir, ".daemon-secret"), randomBytes(32).toString("hex"), {
      mode: 0o600,
    });
  } else {
    writeFileSync(join(dataDir, ".daemon-secret"), opts.daemonSecret, {
      mode: 0o600,
    });
  }
  const env = {
    ...process.env,
    FRIDAY_DATA_DIR: dataDir,
    DATABASE_URL: opts.databaseUrl,
  };
  const child = spawn("node", [DAEMON_ENTRY], {
    cwd: REPO_ROOT,
    env,
    // See spawnZeroCacheForTest: detached → own process group →
    // group-wide SIGTERM in cleanup catches every subprocess.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  if (process.env.FRIDAY_TEST_DEBUG === "1") {
    child.stdout?.on("data", (d) => process.stderr.write(`[daemon stdout] ${d}`));
    child.stderr?.on("data", (d) => process.stderr.write(`[daemon stderr] ${d}`));
  } else {
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
  }
  const ready = waitForTcp(port, { timeoutMs: 15_000 });
  return { port, child, dataDir, ready };
}

export interface DashboardHandle {
  port: number;
  child: ChildProcess;
  ready: Promise<void>;
}

export interface SpawnDashboardOpts {
  databaseUrl: string;
  zeroCachePort: number;
  daemonPort: number;
  authSecret: string;
  betterAuthSecret: string;
  daemonSecret: string;
  dataDir: string;
  port?: number;
}

export async function spawnDashboardForTest(opts: SpawnDashboardOpts): Promise<DashboardHandle> {
  const port = opts.port ?? (await freePort());
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    DATABASE_URL: opts.databaseUrl,
    ZERO_AUTH_SECRET: opts.authSecret,
    ZERO_ADMIN_PASSWORD: "test-admin-password",
    BETTER_AUTH_SECRET: opts.betterAuthSecret,
    BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    ZERO_CACHE_HOST: "127.0.0.1",
    ZERO_CACHE_PORT: String(opts.zeroCachePort),
    ZERO_MUTATE_URL: `http://127.0.0.1:${port}/api/mutators`,
    FRIDAY_DATA_DIR: opts.dataDir,
    NODE_ENV: "production",
  };
  const child = spawn("node", [DASHBOARD_ENTRY], {
    cwd: DASHBOARD_DIR,
    env,
    // See spawnZeroCacheForTest: detached → own process group →
    // group-wide SIGTERM in cleanup catches every subprocess.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  // FRIDAY_TEST_DEBUG=1 surfaces subprocess output to the test runner's
  // stderr so debugging spawner / dashboard boot issues doesn't require
  // editing the harness. Default silent so e2e log noise stays low.
  if (process.env.FRIDAY_TEST_DEBUG === "1") {
    child.stdout?.on("data", (d) => process.stderr.write(`[dash stdout] ${d}`));
    child.stderr?.on("data", (d) => process.stderr.write(`[dash stderr] ${d}`));
  } else {
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
  }
  const ready = waitForTcp(port, { timeoutMs: 15_000 });
  return { port, child, ready };
}

// ─────────────────────────────────────────────────────────────────────
// Auth-bypass helper. The dashboard's `hooks.server.ts` gates every
// /api/* call on a valid BetterAuth session cookie. Hand-signing the
// cookie is brittle (better-call URL-encodes the wire format, signs
// with WebCrypto, validates with a 44-char `endsWith("=")` length
// check, and rejects on any mismatch). Instead we go through the real
// HTTP sign-in flow: seed a user + credential-account row in the
// scratch DB, then POST `/api/auth/sign-in/email` against the live
// dashboard subprocess. The returned `Set-Cookie` header is by
// definition a cookie the same BetterAuth instance accepts.
// ─────────────────────────────────────────────────────────────────────

const TEST_PASSWORD = "test-password-123";

export interface TestSessionCookie {
  /** The full HTTP Cookie header value to attach to test requests. */
  cookie: string;
  /** User id of the test account (FK target for any test data rows). */
  userId: string;
  /** Device id baked into the friday-device-id cookie. */
  deviceId: string;
  /** Session token (the un-signed token, useful for direct DB joins). */
  sessionToken: string;
}

/**
 * BetterAuth's scrypt hash — must match `@better-auth/utils/password`
 * exactly so the dashboard's sign-in path verifies the seeded password.
 * Cribbed from `@better-auth/utils@0.4.0/dist/password.node.mjs` —
 * N=16384, r=16, p=1, dkLen=64, hex(salt) + ":" + hex(key).
 */
async function hashBetterAuthPassword(password: string): Promise<string> {
  const { scrypt, randomBytes } = await import("node:crypto");
  const salt = randomBytes(16).toString("hex");
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      64,
      { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 },
      (err, derived) => (err ? reject(err) : resolve(derived as Buffer)),
    );
  });
  return `${salt}:${key.toString("hex")}`;
}

export interface MintTestSessionOpts {
  databaseUrl: string;
  /** Dashboard HTTP origin (e.g. http://127.0.0.1:50905). The sign-in
   *  POST round-trips through this so BetterAuth produces the cookie. */
  dashboardBase: string;
  /** Email of the test user; same email reuses the existing user row. */
  email?: string;
  /** Display name. */
  name?: string;
}

export async function mintTestSessionCookie(opts: MintTestSessionOpts): Promise<TestSessionCookie> {
  // BetterAuth validates email with `z.email()` which rejects host-only
  // addresses (`foo@local`), so use a fully-qualified test address.
  const email = opts.email ?? "e2e-test@example.com";
  const name = opts.name ?? "E2E Test";
  const c = new Client({ connectionString: opts.databaseUrl });
  await c.connect();
  let persistedUserId: string;
  try {
    // Upsert the user row by email — reuse across tests in the same env
    // so a multi-context test (e.g. convergence) sees the same userId
    // on both clients without coordinating.
    const now = new Date();
    const userRes = await c.query<{ id: string }>(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, true, $4, $4)
       ON CONFLICT (email) DO UPDATE SET "updatedAt" = $4
       RETURNING id`,
      [randomUUID(), name, email, now],
    );
    persistedUserId = userRes.rows[0]!.id;
    // Seed the credential account so the email/password sign-in path
    // succeeds. BetterAuth stores the password hash on the `account`
    // row with `providerId='credential'` and `accountId=<userId>`. The
    // schema has no unique constraint covering (providerId, accountId),
    // so DELETE-then-INSERT instead of ON CONFLICT.
    const passwordHash = await hashBetterAuthPassword(TEST_PASSWORD);
    await c.query(`DELETE FROM "account" WHERE "providerId" = 'credential' AND "userId" = $1`, [
      persistedUserId,
    ]);
    await c.query(
      `INSERT INTO "account"
         (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
       VALUES ($1, $2, 'credential', $3, $4, $5, $5)`,
      [randomUUID(), persistedUserId, persistedUserId, passwordHash, now],
    );
  } finally {
    await c.end();
  }

  // Sign in via the dashboard's BetterAuth HTTP handler — this produces
  // a Set-Cookie header that the same BetterAuth instance will accept
  // on subsequent requests. Origin matches BETTER_AUTH_URL (set by the
  // dashboard spawner) so the CSRF gate passes.
  const signInRes = await fetch(`${opts.dashboardBase}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: opts.dashboardBase,
    },
    body: JSON.stringify({ email, password: TEST_PASSWORD, rememberMe: true }),
  });
  if (!signInRes.ok) {
    const body = await signInRes.text();
    throw new Error(`mintTestSessionCookie: sign-in failed ${signInRes.status} ${body}`);
  }
  // adapter-node merges Set-Cookie headers into a single comma-joined
  // string when accessed via `headers.get`, but `getSetCookie()` (Node
  // 18.14+ / undici) preserves the array. Either way, parse out the
  // name=value pairs and rebuild as a Cookie header.
  const setCookies = signInRes.headers.getSetCookie
    ? signInRes.headers.getSetCookie()
    : [signInRes.headers.get("set-cookie") ?? ""];
  const cookiePairs: string[] = [];
  let sessionToken = "";
  for (const sc of setCookies) {
    if (!sc) continue;
    const firstSemi = sc.indexOf(";");
    const pair = firstSemi === -1 ? sc : sc.slice(0, firstSemi);
    cookiePairs.push(pair);
    const eq = pair.indexOf("=");
    if (eq > 0) {
      const k = pair.slice(0, eq).trim();
      if (k.endsWith(".session_token")) {
        // value is URL-encoded `token.signature` — decode and split on
        // the LAST `.` to recover the raw token.
        const decoded = decodeURIComponent(pair.slice(eq + 1));
        const lastDot = decoded.lastIndexOf(".");
        sessionToken = lastDot >= 0 ? decoded.slice(0, lastDot) : decoded;
      }
    }
  }
  // Stamp a friday-device-id cookie alongside — tests that mint a JWT
  // via /api/sync/refresh pull this from the cookie jar, so harness
  // callers shouldn't have to remember to add it.
  const deviceId = randomUUID();
  cookiePairs.push(`friday-device-id=${deviceId}`);
  return {
    cookie: cookiePairs.join("; "),
    userId: persistedUserId,
    deviceId,
    sessionToken,
  };
}

// ─────────────────────────────────────────────────────────────────────
// spawnTestSyncEnv: the composed factory. The previous scaffold only
// gave callers a scratch DB; this version returns a full multi-process
// environment ready for e2e assertions.
// ─────────────────────────────────────────────────────────────────────

export interface SyncEnv {
  databaseUrl: string;
  db: TestDbHandle;
  daemon: DaemonHandle;
  dashboard: DashboardHandle;
  zeroCache: ZeroCacheHandle;
  betterAuthSecret: string;
  zeroAuthSecret: string;
  daemonSecret: string;
  /** Mint a signed session cookie for hitting /api/* on the dashboard.
   *  Each call returns a fresh sessionId; pass `email` to reuse a user. */
  mintCookie: (opts?: { email?: string; name?: string }) => Promise<TestSessionCookie>;
  cleanup(): Promise<void>;
}

export interface SpawnEnvOpts {
  label?: string;
  /** Skip the dashboard subprocess — used by daemon-only stress tests. */
  skipDashboard?: boolean;
  /** Skip the daemon subprocess — used by dashboard-only tests. */
  skipDaemon?: boolean;
  /** Skip zero-cache — used when the test only needs the scratch DB. */
  skipZeroCache?: boolean;
}

export async function spawnTestSyncEnv(opts: SpawnEnvOpts = {}): Promise<SyncEnv> {
  const db = await createTestDb({ label: opts.label ?? "sync_env" });
  const databaseUrl = db.databaseUrl;
  const betterAuthSecret = randomBytes(32).toString("hex");
  const zeroAuthSecret = randomBytes(32).toString("hex");
  const daemonSecret = randomBytes(32).toString("hex");
  // Set this so the friday_pub publication exists for zero-cache to
  // bind to. createTestDb ran migrations but didn't create the
  // publication. CREATE PUBLICATION FOR ALL TABLES requires superuser;
  // the friday role doesn't have it locally, so use the test runner's
  // user (which CREATE'd the DB and is its owner). Skipped when the
  // caller opts out of zero-cache (e.g., pure SQL trigger tests).
  if (!opts.skipZeroCache) {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    try {
      await admin.query("CREATE PUBLICATION friday_pub FOR ALL TABLES");
    } finally {
      await admin.end();
    }
  }

  const zeroCachePort = await freePort();
  const daemonPort = await freePort();
  const dashboardPort = await freePort();

  // Track partially-spawned subprocesses so a failure during setup
  // still tears them down. Without this, a timeout in zero-cache.ready
  // leaks the daemon + zero-cache subprocesses + their PG connections,
  // which leaves the next test's PG pool exhausted ("too many clients
  // already") and the next harness boot hitting EADDRINUSE.
  let zeroCache: ZeroCacheHandle | null = null;
  let daemon: DaemonHandle | null = null;
  let dashboard: DashboardHandle | null = null;
  try {
    // SERIALIZE the spawn chain. Earlier versions spawned all three
    // subprocesses in parallel and waited on their `.ready` promises
    // together; that pattern raced zero-cache's `initial CVR snapshot`
    // (which takes a table-level lock on the publication's tables)
    // against the daemon's `evolve.projector.boot-sync` writes to
    // `evolve_proposals`. The contention surfaced as Postgres
    // `canceling statement due to lock timeout`, zero-cache crashing
    // mid-setup, and every subsequent WS connect timing out with
    // "Zero was unable to connect for 60 seconds." The order below
    // (zero-cache → daemon → dashboard, each fully ready before the
    // next starts) eliminates that race.
    if (!opts.skipZeroCache) {
      zeroCache = await spawnZeroCacheForTest({
        databaseUrl,
        authSecret: zeroAuthSecret,
        adminPassword: "test-admin-password",
        port: zeroCachePort,
        // dashboardPort is pre-allocated above; zero-cache needs the
        // dashboard's mutator URL at boot to accept custom-mutator
        // pushes. Without this every Zero `mutate.*` call dies on
        // the server with `InvalidPush: A ZERO_MUTATE_URL must be
        // set in order to process custom mutations`, the optimistic
        // client write never converges, and the PG row never lands.
        mutateUrl: opts.skipDashboard
          ? undefined
          : `http://127.0.0.1:${dashboardPort}/api/mutators`,
      });
      await zeroCache.ready;
    }
    if (!opts.skipDaemon) {
      daemon = await spawnDaemonForTest({
        databaseUrl,
        port: daemonPort,
        daemonSecret,
      });
      await daemon.ready;
    }

    if (!opts.skipDashboard) {
      dashboard = await spawnDashboardForTest({
        databaseUrl,
        zeroCachePort,
        daemonPort,
        authSecret: zeroAuthSecret,
        betterAuthSecret,
        daemonSecret,
        dataDir: daemon?.dataDir ?? mkdtempSync(join(tmpdir(), "friday-dash-")),
        port: dashboardPort,
      });
      await dashboard.ready;
    }
  } catch (err) {
    // Best-effort partial cleanup so a setup failure doesn't leak
    // subprocesses / PG connections / replica files.
    if (dashboard) await sigtermThenSigkill(dashboard.child);
    if (daemon) {
      await sigtermThenSigkill(daemon.child);
      try {
        rmSync(daemon.dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    if (zeroCache) {
      await sigtermThenSigkill(zeroCache.child);
      try {
        rmSync(zeroCache.replicaFile, { force: true });
        rmSync(zeroCache.replicaFile + "-shm", { force: true });
        rmSync(zeroCache.replicaFile + "-wal", { force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      await db.drop();
    } catch {
      /* ignore */
    }
    throw err;
  }

  const env: SyncEnv = {
    databaseUrl,
    db,
    // The Skip* opts produce nulls here; the interface keeps these
    // non-null for the (overwhelming) typical case. Callers that pass
    // a skip flag are responsible for not dereferencing the missing
    // handle — see how `unread-count-trigger.test.ts` only touches
    // `env.db` after a `skipDaemon: true, skipZeroCache: true` boot.
    daemon: daemon as unknown as DaemonHandle,
    dashboard: dashboard as unknown as DashboardHandle,
    zeroCache: zeroCache as unknown as ZeroCacheHandle,
    betterAuthSecret,
    zeroAuthSecret,
    daemonSecret,
    mintCookie: async (cookieOpts = {}) => {
      if (!dashboard) {
        throw new Error(
          "mintCookie requires the dashboard subprocess; spawn the env without skipDashboard",
        );
      }
      return mintTestSessionCookie({
        databaseUrl,
        dashboardBase: `http://127.0.0.1:${dashboard.port}`,
        ...cookieOpts,
      });
    },
    cleanup: async () => {
      // SIGTERM in reverse spawn order: dashboard depends on daemon +
      // zero-cache; daemon depends on the database; zero-cache depends
      // on the database. Tear down top-down. NB: read `env.daemon` at
      // call time, not the closure's local — the resilience suite
      // reassigns `env.daemon = fresh` after a restart and the cleanup
      // needs to signal the *current* process, not the one that died.
      const currentDaemon = env.daemon ?? daemon;
      if (dashboard) await sigtermThenSigkill(dashboard.child);
      if (currentDaemon) {
        await sigtermThenSigkill(currentDaemon.child);
        try {
          rmSync(currentDaemon.dataDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      if (zeroCache) {
        await sigtermThenSigkill(zeroCache.child);
        try {
          rmSync(zeroCache.replicaFile, { force: true });
          rmSync(zeroCache.replicaFile + "-shm", { force: true });
          rmSync(zeroCache.replicaFile + "-wal", { force: true });
        } catch {
          /* ignore */
        }
        // zero-cache leaves a logical-replication slot on the upstream
        // DB. Postgres refuses DROP DATABASE while a slot exists for
        // that DB. The slot can also remain `active=true` for a brief
        // window after zero-cache's SIGKILL while the walsender
        // backend finishes draining — `pg_drop_replication_slot`
        // refuses to drop an active slot. Force-disconnect the
        // walsender first, then drop the slot, then `db.drop()`.
        // Without this every e2e run leaks its scratch DB and
        // `friday_test_*` accumulates in pg_database.
        try {
          const admin = new Client({ connectionString: databaseUrl });
          await admin.connect();
          try {
            await admin.query(
              `SELECT pg_terminate_backend(active_pid)
                 FROM pg_replication_slots
                 WHERE database = current_database()
                   AND active_pid IS NOT NULL`,
            );
            // Small grace for the terminated walsender to release.
            await new Promise((r) => setTimeout(r, 200));
            await admin.query(
              `SELECT pg_drop_replication_slot(slot_name)
                 FROM pg_replication_slots
                 WHERE database = current_database()`,
            );
          } finally {
            await admin.end();
          }
        } catch {
          /* slot gone or DB unreachable — DROP DATABASE will tell us */
        }
      }
      await db.drop();
    },
  };
  return env;
}
