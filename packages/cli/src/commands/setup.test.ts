// Regression + behavior tests for the `friday setup` command.
//
// Ordering regression (fixed 2026-06-11): setup called runMigrations() — which
// needs DATABASE_URL — BEFORE provisionPostgres(), the step that mints the
// role/db and writes DATABASE_URL. On a fresh Postgres-era box that threw a
// circular "DATABASE_URL is not set — run friday setup" error, blocking every
// first-time install. provisionPostgres() is the single source of truth.
//
// Behavior (added 2026-06-11): setup always initializes the secrets vault, and
// restarts Postgres ONLY when provisioning flipped wal_level to logical.
//
// We mock setup's dependencies to record call order / side effects — the
// orchestration is the unit under test, not the mocked helpers.

import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];
const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
// Mutable control read by the provisionPostgres mock (vitest lets the hoisted
// factory close over module-level bindings, same as `calls`/`fakeDb` below).
const ctl = { walLevelChanged: false };

const DB_URL = "postgresql://friday@localhost:5432/friday";

// A fake drizzle handle: db.select().from(x).limit(n) → resolves to one
// existing user, so setup takes the "keep existing account" branch and never
// hits the interactive email/password prompts.
const fakeDb = {
  select: () => ({
    from: () => ({ limit: () => Promise.resolve([{ id: "u1", email: "existing@example.com" }]) }),
  }),
};

vi.mock("@friday/shared", () => ({
  CONFIG_PATH: "/tmp/friday-setup-test/config.json",
  // FRI-166: setup.ts → lib/cloudflared.ts reads STATE_DIR at module load to
  // compute the installed-token fingerprint path; the mock must provide it.
  STATE_DIR: "/tmp/friday-setup-test/state",
  DEFAULT_CONFIG: {},
  ensureDirs: () => calls.push("ensureDirs"),
  ensureSoul: () => calls.push("ensureSoul"),
  loadConfig: () => ({}),
  loadFridayConfig: () => ({
    betterAuthSecret: "test-secret",
    cloudflareTunnelToken: undefined,
    databaseUrl: DB_URL,
  }),
  provisionPostgres: vi.fn(async () => {
    calls.push("provisionPostgres");
    return {
      freshInstall: true,
      appliedMigrations: [],
      databaseUrl: DB_URL,
      createdPublication: true,
      walLevelChanged: ctl.walLevelChanged,
    };
  }),
  probePostgresHealth: async () => ({
    reachable: true,
    walLevelLogical: true,
    walLevelActual: "logical",
  }),
  resolveDashboardPort: () => 7615,
  generateAgeKeypair: async () => {
    calls.push("generateAgeKeypair");
    return { identity: "i", recipient: "r" };
  },
  initVault: async () => {
    calls.push("initVault");
  },
  patchFridayGitignore: () => {},
  upsertIntegrationSecret: async () => {},
  writeConfig: () => {},
  AGE_KEY_PATH: "/tmp/friday-setup-test/.age-key",
  getDb: () => {
    calls.push("getDb");
    return fakeDb;
  },
  // Not used by the fixed code, but exported so a re-introduced premature
  // runMigrations() call is recorded (and caught by the ordering assertions)
  // rather than crashing on an undefined import.
  runMigrations: async () => calls.push("runMigrations"),
  schema: { users: {}, accounts: {} },
}));

vi.mock("@friday/shared/services", () => ({
  resetRateLimitPrefix: async () => 0,
  revokeAllSessionsForUser: async () => 0,
}));

// Record + neutralize child_process so the wal_level restart helper never runs
// a real `brew services restart` during the test.
vi.mock("node:child_process", () => ({
  spawnSync: (cmd: string, args: string[] = []) => {
    spawnCalls.push({ cmd, args });
    return { status: 0 };
  },
}));

// Non-interactive prompt stubs. confirm: "Keep existing account?" → true so the
// existing-account path is a no-op; any other confirm (e.g. the Cloudflare
// offer) → false so runCloudflareSetup returns immediately.
vi.mock("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  confirm: async ({ message }: { message: string }) => message.includes("Keep"),
  text: async () => "noone@example.com",
  password: async () => "password1234",
}));

vi.mock("better-auth", () => ({
  betterAuth: () => ({ api: { signUpEmail: async () => {} }, $context: Promise.resolve({}) }),
}));
vi.mock("better-auth/adapters/drizzle", () => ({ drizzleAdapter: () => ({}) }));
vi.mock("../lib/branding.js", () => ({ BANNER: "" }));

import { setupCommand } from "./setup.js";
import { provisionPostgres } from "@friday/shared";

async function runSetup(): Promise<void> {
  await (setupCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<void>)({
    args: { "reset-password": false, cloudflare: false },
  });
}

const brewRestarted = (): boolean =>
  spawnCalls.some((c) => c.cmd === "brew" && c.args.join(" ") === "services restart postgresql@18");

beforeEach(() => {
  calls.length = 0;
  spawnCalls.length = 0;
  ctl.walLevelChanged = false;
  vi.clearAllMocks();
});

describe("friday setup — provisioning order", () => {
  it("provisions Postgres BEFORE any DB access (no premature migrate)", async () => {
    await runSetup();

    expect(calls).toContain("provisionPostgres");
    expect(calls).toContain("getDb");
    // The exact regression: provision must precede the first DB handle.
    expect(calls.indexOf("provisionPostgres")).toBeLessThan(calls.indexOf("getDb"));
  });

  it("does not call any migrate/DB step before provisionPostgres", async () => {
    await runSetup();

    const provisionIdx = calls.indexOf("provisionPostgres");
    const before = calls.slice(0, provisionIdx);
    // Nothing that touches the DB may appear before provision — neither a DB
    // handle nor a standalone migrate (the exact thing that regressed).
    expect(before).not.toContain("getDb");
    expect(before).not.toContain("runMigrations");
  });

  it("aborts (process.exit) when provisioning fails instead of limping into a DB error", async () => {
    (provisionPostgres as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("pg_isready failed");
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("__exit__");
    }) as never);

    await expect(runSetup()).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
    // Crucially, we never reached the account/DB phase.
    expect(calls).not.toContain("getDb");

    exitSpy.mockRestore();
  });
});

describe("friday setup — vault + Postgres restart", () => {
  it("always initializes the secrets vault on a fresh install", async () => {
    await runSetup();
    expect(calls).toContain("generateAgeKeypair");
    expect(calls).toContain("initVault");
  });

  it("restarts Postgres when provisioning flipped wal_level to logical", async () => {
    ctl.walLevelChanged = true;
    await runSetup();
    expect(brewRestarted()).toBe(true);
  });

  it("does NOT restart Postgres when wal_level was already logical", async () => {
    ctl.walLevelChanged = false;
    await runSetup();
    expect(brewRestarted()).toBe(false);
  });
});
