import { defineCommand } from "citty";
import { confirm, intro, outro, password, text } from "@clack/prompts";
import pc from "picocolors";
import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  ensureDirs,
  ensureFridayEnv,
  ensureSoul,
  loadConfig,
  provisionPostgres,
  resolveDashboardPort,
  upsertEnvVar,
  writeConfig,
  getDb,
  runMigrations,
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
    ensureFridayEnv(); // load + generate BETTER_AUTH_SECRET if needed
    await runMigrations();
    ensureSoul();

    // Phase 0 (ADR-023): provision the Postgres canonical store side-by-side
    // with the still-active SQLite chain. The daemon code path keeps using
    // SQLite until Phase 1 cuts it over; this step gets the new home ready.
    try {
      console.log(pc.dim("  provisioning Postgres (ADR-023)…"));
      const result = await provisionPostgres({
        log: (msg) => console.log(pc.dim(msg)),
      });
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
          "  Setup will continue with the legacy SQLite store. Re-run `friday setup` once Postgres is available.",
        ),
      );
    }

    if (!existsSync(CONFIG_PATH)) {
      writeConfig(DEFAULT_CONFIG);
      console.log(pc.dim(`  wrote ${CONFIG_PATH}`));
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
      secret: process.env.BETTER_AUTH_SECRET!,
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

    outro(pc.green("Setup complete."));
  },
});

async function runCloudflareSetup({ force }: { force: boolean }): Promise<void> {
  const tokenAlreadySet = !!process.env.CLOUDFLARE_TUNNEL_TOKEN;
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

  upsertEnvVar("CLOUDFLARE_TUNNEL_TOKEN", token);
  cfg.publicUrl = publicUrl.trim();
  writeConfig(cfg);
  console.log(pc.green(`  token saved → ~/.friday/.env`));
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
        "  the token is saved in ~/.friday/.env; re-run `friday setup --cloudflare` to retry the launch agent install.",
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
