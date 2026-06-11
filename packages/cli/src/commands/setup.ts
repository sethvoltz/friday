import { defineCommand } from "citty";
import { confirm, intro, outro, password, text } from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  ensureDirs,
  ensureSoul,
  loadConfig,
  loadFridayConfig,
  provisionPostgres,
  probePostgresHealth,
  resolveDashboardPort,
  generateAgeKeypair,
  initVault,
  patchFridayGitignore,
  upsertIntegrationSecret,
  writeConfig,
  AGE_KEY_PATH,
  getDb,
  schema,
} from "@friday/shared";
import { resetRateLimitPrefix, revokeAllSessionsForUser } from "@friday/shared/services";
import { BANNER } from "../lib/branding.js";

export const setupCommand = defineCommand({
  meta: {
    name: "setup",
    description: "Idempotent first-time setup: create account, init ~/.friday/.",
  },
  args: {
    "reset-password": {
      type: "boolean",
      description: "Reset the primary user's password",
      default: false,
    },
    cloudflare: {
      type: "boolean",
      description: "Skip account flow; configure Cloudflare Tunnel token + public URL only",
      default: false,
    },
  },
  async run({ args }) {
    console.log(BANNER);
    intro(pc.bold(pc.cyan("Friday — setup")));

    ensureDirs();
    // FRI-150 (pivot, ADR-037): loadFridayConfig() generates
    // BETTER_AUTH_SECRET / ZERO_AUTH_SECRET / ZERO_ADMIN_PASSWORD if
    // missing and writes them to ~/.friday/.env. The returned object is
    // read later when we need the secrets — `process.env` is NOT mutated.
    loadFridayConfig();
    ensureSoul();

    // Provision the Postgres canonical store (ADR-023). This is the single
    // place that creates the `friday` role + database, writes DATABASE_URL to
    // ~/.friday/.env (clearing the config cache), AND applies Drizzle
    // migrations. It MUST run before any DB access below — there is no separate
    // runMigrations() step (provisionPostgres owns migrations, and a standalone
    // runMigrations() here would throw "DATABASE_URL not set" on a fresh box,
    // before this step has minted the URL).
    let walLevelChanged = false;
    try {
      console.log(pc.dim("  provisioning Postgres (ADR-023)…"));
      const result = await provisionPostgres({
        log: (msg) => console.log(pc.dim(msg)),
      });
      walLevelChanged = result.walLevelChanged;
      if (result.freshInstall) {
        console.log(
          pc.green(
            `  Postgres ready (fresh): ${result.appliedMigrations.length} migration(s) applied`,
          ),
        );
      } else if (result.appliedMigrations.length > 0) {
        console.log(
          pc.green(
            `  Postgres up to date after applying ${result.appliedMigrations.length} migration(s)`,
          ),
        );
      } else {
        console.log(pc.green("  Postgres at head"));
      }
    } catch (err) {
      console.error(
        pc.red(
          `  Postgres provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      console.error(
        pc.dim(
          "  Postgres is required. Ensure it's running (`brew services start postgresql@18`), then re-run `friday setup`.",
        ),
      );
      process.exit(1);
    }

    if (!existsSync(CONFIG_PATH)) {
      writeConfig(DEFAULT_CONFIG);
      console.log(pc.dim(`  wrote ${CONFIG_PATH}`));
    }

    // Always initialize the secrets vault on setup (ADR-038) so a fresh install
    // lands with a working vault + age key, not a `no_vault` doctor failure.
    // Idempotent: skipped when the age key already exists. Integration secrets
    // (incl. the Cloudflare token) are added later into this same vault via
    // `friday secrets set` / `friday setup --cloudflare`.
    if (!existsSync(AGE_KEY_PATH)) {
      const { identity, recipient } = await generateAgeKeypair();
      await initVault(identity, recipient);
      patchFridayGitignore();
      console.log(pc.green("  secrets vault initialized"));
    }

    if (args.cloudflare) {
      await runCloudflareSetup({ force: true });
      outro(pc.green("Cloudflare Tunnel configured."));
      return;
    }

    // Spin up a local BetterAuth instance with sign-up *temporarily* enabled.
    // This is the only place sign-up is allowed; the dashboard's BetterAuth
    // instance keeps `disableSignUp: true` so the public surface can never
    // create an account. Hashing format matches automatically.
    const cfg = loadConfig();
    const db = getDb();
    const auth = betterAuth({
      // Our schema exports keys with plural names (`users`, `sessions`,
      // `accounts`, `verifications`) while the physical pg tables use
      // BetterAuth's expected singular names (`user`, `session`, etc.).
      // `usePlural: true` tells the adapter to look up the plural symbol.
      database: drizzleAdapter(db, { provider: "pg", schema, usePlural: true }),
      baseURL: process.env.BETTER_AUTH_URL ?? `http://localhost:${resolveDashboardPort(cfg)}`,
      emailAndPassword: { enabled: true, disableSignUp: false },
      secret: loadFridayConfig().betterAuthSecret,
    });

    const existing = await db.select().from(schema.users).limit(1);

    if (existing.length === 0) {
      const email = (await text({
        message: "Email (login id — any address; nothing is sent):",
        validate: (v) => (v && v.includes("@") ? undefined : "must contain @"),
      })) as string;
      const name = (await text({
        message: "Display name:",
        initialValue: email.split("@")[0],
      })) as string;
      const pw = (await password({
        message: "Password:",
        validate: (v) => (!v || v.length < 8 ? "minimum 8 characters" : undefined),
      })) as string;

      try {
        await auth.api.signUpEmail({
          body: { email, password: pw, name },
        });
        console.log(pc.green(`  created account for ${email}`));
      } catch (err) {
        console.error(
          pc.red(`  signup failed: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exit(1);
      }
    } else if (args["reset-password"]) {
      const user = existing[0];
      const pw = (await password({
        message: `New password for ${user.email}:`,
        validate: (v) => (!v || v.length < 8 ? "minimum 8 characters" : undefined),
      })) as string;
      try {
        const ctx = await auth.$context;
        const hashed = await ctx.password.hash(pw);
        await db
          .update(schema.accounts)
          .set({ password: hashed, updatedAt: new Date() })
          .where(eq(schema.accounts.userId, user.id));
        // FIX_FORWARD 5.7: a legitimate password reset should clear any
        // pending sign-in lockouts left by the forgotten attempts that
        // led the user here.
        const cleared = await resetRateLimitPrefix("auth:");
        // FIX_FORWARD 5.11: revoke every active session — a forgotten
        // password is a security-event class, and any old cookie an
        // attacker may have lifted should stop working immediately.
        const revoked = await revokeAllSessionsForUser(user.id);
        console.log(pc.green(`  password updated for ${user.email}`));
        if (revoked > 0) {
          console.log(pc.dim(`  revoked ${revoked} active session${revoked === 1 ? "" : "s"}`));
        }
        if (cleared > 0) {
          console.log(
            pc.dim(`  cleared ${cleared} stale auth rate-limit entr${cleared === 1 ? "y" : "ies"}`),
          );
        }
      } catch (err) {
        console.error(
          pc.red(`  reset failed: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exit(1);
      }
    } else {
      console.log(pc.dim(`  existing account: ${existing[0].email} — keep? [Y/n]`));
      const keep = (await confirm({ message: "Keep existing account?" })) as boolean;
      if (!keep) {
        const ok = (await confirm({
          message: pc.red("This will DELETE the user account. Are you absolutely sure?"),
        })) as boolean;
        if (ok) {
          await db.delete(schema.accounts);
          await db.delete(schema.users);
          console.log(pc.yellow("  account deleted; re-run `friday setup`"));
        }
      }
    }

    await runCloudflareSetup({ force: false });

    // If provisioning flipped wal_level to logical, restart Postgres so the
    // change takes effect — otherwise zero-cache boot-loops on first `friday
    // start`. Gated on walLevelChanged, so a re-setup on a box that's already
    // logical never bounces a running Postgres.
    if (walLevelChanged) {
      await restartPostgresForWalLevel();
    }

    outro(pc.green("Setup complete."));
  },
});

// `wal_level` changed to logical this run — ALTER SYSTEM needs a full Postgres
// restart to take effect. Do it for the user so a fresh install is usable
// end-to-end without a manual step (the warning was easy to miss). Best-effort:
// if the brew service isn't how Postgres is managed, fall back to instructing.
async function restartPostgresForWalLevel(): Promise<void> {
  console.log(pc.dim("  restarting Postgres to activate wal_level=logical…"));
  const r = spawnSync("brew", ["services", "restart", "postgresql@18"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (r.status !== 0) {
    console.log(
      pc.yellow(
        "  could not auto-restart Postgres — run `brew services restart postgresql@18` manually, then `friday doctor`.",
      ),
    );
    return;
  }
  // Wait (bounded) for Postgres to accept connections again so the next
  // `friday start` / `friday doctor` is clean.
  for (let i = 0; i < 30; i++) {
    const health = await probePostgresHealth();
    if (health.reachable) {
      console.log(
        health.walLevelLogical
          ? pc.green("  Postgres restarted — wal_level=logical active")
          : pc.yellow(
              "  Postgres restarted but wal_level still not logical — check `friday doctor`.",
            ),
      );
      return;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  console.log(
    pc.yellow("  Postgres restarted but not ready yet — re-run `friday doctor` shortly."),
  );
}

async function runCloudflareSetup({ force }: { force: boolean }): Promise<void> {
  const tokenAlreadySet = !!loadFridayConfig().cloudflareTunnelToken;
  const cfg = loadConfig();
  const message = tokenAlreadySet
    ? "Replace existing Cloudflare Tunnel token?"
    : "Set up Cloudflare Tunnel for public access? (optional)";

  if (!force) {
    const proceed = (await confirm({
      message,
      initialValue: false,
    })) as boolean | symbol;
    if (typeof proceed !== "boolean" || !proceed) return;
  }

  const token = (await password({
    message: "Connector token (Cloudflare Zero Trust → Networks → Tunnels):",
    mask: "•",
    validate: (v) => (v && v.length > 20 ? undefined : "token looks too short"),
  })) as string;

  const initialUrl = cfg.publicUrl ?? "https://friday.example.com";
  const publicUrl = (await text({
    message: "Public URL (e.g. https://friday.example.com):",
    initialValue: initialUrl,
    validate: (v) => (v && /^https?:\/\//.test(v) ? undefined : "must start with http(s)://"),
  })) as string;

  if (!existsSync(AGE_KEY_PATH)) {
    const { identity, recipient } = await generateAgeKeypair();
    await initVault(identity, recipient);
    patchFridayGitignore();
  }
  await upsertIntegrationSecret(
    { name: "CLOUDFLARE_TUNNEL_TOKEN", mode: "env", daemon: true },
    token,
  );
  cfg.publicUrl = publicUrl.trim();
  writeConfig(cfg);
  console.log(pc.green(`  token saved → secrets vault`));
  console.log(pc.green(`  publicUrl saved → ${cfg.publicUrl}`));

  installCloudflaredLaunchAgent(token);
}

// Connector-token tunnels need `cloudflared tunnel run --token <T>`. The
// `homebrew.mxcl.cloudflared` plist that `brew services start cloudflared`
// would load runs `cloudflared` bare — no args, no token — so it spins on
// "permission denied" and exits 1. The canonical token-tunnel path is
// `cloudflared service install <T>`, which writes its own user launch
// agent (`~/Library/LaunchAgents/com.cloudflare.cloudflared.plist`) and
// bootstraps it. We sidestep brew's plist entirely.
function installCloudflaredLaunchAgent(token: string): void {
  const cloudflaredOnPath = spawnSync("which", ["cloudflared"], { stdio: "ignore" }).status === 0;
  if (!cloudflaredOnPath) {
    console.log(
      pc.yellow(
        "  cloudflared not on PATH — install with `brew install cloudflared` then re-run `friday setup --cloudflare`",
      ),
    );
    return;
  }

  // Clean up brew's bare-cloudflared job if a prior install loaded it; the
  // formula's auto-generated plist is incompatible with token tunnels.
  const brewHasCloudflared =
    spawnSync("brew", ["list", "cloudflared"], { stdio: "ignore" }).status === 0;
  if (brewHasCloudflared) {
    spawnSync("brew", ["services", "stop", "cloudflared"], { stdio: "ignore" });
  }

  // Idempotent: replaces any prior `cloudflared service install` (token
  // rotation, re-run setup, etc.). The uninstall is best-effort — it
  // errors out cleanly if nothing is installed, which we don't care about.
  spawnSync("cloudflared", ["service", "uninstall"], { stdio: "ignore" });

  const install = spawnSync("cloudflared", ["service", "install", token], { encoding: "utf8" });
  if (install.status !== 0) {
    console.error(pc.red("  cloudflared service install failed:"));
    if (install.stderr.trim()) console.error(install.stderr.trim());
    if (install.stdout.trim()) console.error(install.stdout.trim());
    console.error(
      pc.dim(
        "  the token is saved in the secrets vault; re-run `friday setup --cloudflare` to retry the launch agent install.",
      ),
    );
    return;
  }
  console.log(
    pc.green(
      "  cloudflared launch agent installed → ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist",
    ),
  );
}
