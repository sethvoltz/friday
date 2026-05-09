import { defineCommand } from "citty";
import { confirm, intro, outro, password, text } from "@clack/prompts";
import pc from "picocolors";
import { existsSync, writeFileSync } from "node:fs";
import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  ensureDirs,
  ensureFridayEnv,
  ensureSoul,
  loadConfig,
  writeConfig,
  getDb,
  getRawDb,
  runMigrations,
  schema,
} from "@friday/shared";
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
  },
  async run({ args }) {
    console.log(BANNER);
    intro(pc.bold(pc.cyan("Friday — setup")));

    ensureDirs();
    ensureFridayEnv(); // load + generate BETTER_AUTH_SECRET if needed
    runMigrations();
    ensureSoul();

    if (!existsSync(CONFIG_PATH)) {
      writeConfig(DEFAULT_CONFIG);
      console.log(pc.dim(`  wrote ${CONFIG_PATH}`));
    }

    // Spin up a local BetterAuth instance with sign-up *temporarily* enabled.
    // This is the only place sign-up is allowed; the dashboard's BetterAuth
    // instance keeps `disableSignUp: true` so the public surface can never
    // create an account. Hashing format matches automatically.
    const cfg = loadConfig();
    const auth = betterAuth({
      database: getRawDb(),
      baseURL:
        process.env.BETTER_AUTH_URL ??
        `http://localhost:${cfg.dashboardPort}`,
      emailAndPassword: { enabled: true, disableSignUp: false },
      secret: process.env.BETTER_AUTH_SECRET!,
    });

    const db = getDb();
    const existing = db.select().from(schema.users).limit(1).all();

    if (existing.length === 0) {
      const email = (await text({
        message: "Email (login id — any address; nothing is sent):",
        validate: (v) =>
          v && v.includes("@") ? undefined : "must contain @",
      })) as string;
      const name = (await text({
        message: "Display name:",
        initialValue: email.split("@")[0],
      })) as string;
      const pw = (await password({
        message: "Password:",
        validate: (v) =>
          !v || v.length < 8 ? "minimum 8 characters" : undefined,
      })) as string;

      try {
        await auth.api.signUpEmail({
          body: { email, password: pw, name },
        });
        console.log(pc.green(`  created account for ${email}`));
      } catch (err) {
        console.error(
          pc.red(
            `  signup failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exit(1);
      }
    } else if (args["reset-password"]) {
      const user = existing[0];
      const pw = (await password({
        message: `New password for ${user.email}:`,
        validate: (v) =>
          !v || v.length < 8 ? "minimum 8 characters" : undefined,
      })) as string;
      try {
        const ctx = await auth.$context;
        const hashed = await ctx.password.hash(pw);
        db.update(schema.accounts)
          .set({ password: hashed, updatedAt: new Date() })
          .where(eq(schema.accounts.userId, user.id))
          .run();
        console.log(pc.green(`  password updated for ${user.email}`));
      } catch (err) {
        console.error(
          pc.red(
            `  reset failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exit(1);
      }
    } else {
      console.log(
        pc.dim(`  existing account: ${existing[0].email} — keep? [Y/n]`),
      );
      const keep = (await confirm({ message: "Keep existing account?" })) as boolean;
      if (!keep) {
        const ok = (await confirm({
          message: pc.red(
            "This will DELETE the user account. Are you absolutely sure?",
          ),
        })) as boolean;
        if (ok) {
          const raw = getRawDb();
          raw.prepare(`DELETE FROM accounts`).run();
          raw.prepare(`DELETE FROM users`).run();
          console.log(pc.yellow("  account deleted; re-run `friday setup`"));
        }
      }
    }

    outro(pc.green("Setup complete."));
  },
});
