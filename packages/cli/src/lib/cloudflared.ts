/**
 * Declarative reconcile for the Cloudflare Tunnel launch agent (FRI-166).
 *
 * Before FRI-166 the cloudflared agent was managed *imperatively*: `friday
 * setup --cloudflare` ran `cloudflared service install <TOKEN>` once (writing
 * `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist`, OUTSIDE
 * `~/.friday`), and `friday start` never reconciled it. So config/vault state
 * and on-disk launchd reality drifted both directions: a restored
 * tunnel-enabled config left the tunnel DOWN (DR broken), and a removed token
 * left a stale agent serving.
 *
 * This module makes the agent a function of desired state — an explicit
 * **serve-intent** (`config.json` `tunnel.serve`) AND token presence in the
 * vault — and nothing else:
 *
 *   - serve + token  → ensure the agent is installed + running (no re-prompt;
 *                      the token comes from the vault).
 *   - !serve / !token → ensure the agent is stopped + removed.
 *
 * Serve-intent is kept separate from token presence ON PURPOSE: a `--full`
 * restore stages the SOURCE machine's live tunnel token into the target's
 * vault, but the staged box must not auto-serve the public URL (split-brain).
 * `friday restore` forces `serve: false`; cutover flips it back deliberately
 * (`friday tunnel up` / `friday setup --cloudflare`).
 *
 * The decision is a pure function (`decideTunnelAction`) so the full truth
 * table is unit-testable without spawning launchctl/cloudflared; the effectful
 * wrapper (`reconcileTunnel`) wires it to the real binaries.
 *
 * Idempotency: an already-installed agent serving the current token is a
 * no-op (we don't bounce the tunnel on every `friday start`). We catch token
 * rotation by fingerprinting the installed token (SHA-256) into a state file —
 * a vault token whose fingerprint differs from the installed one triggers a
 * reinstall.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pc from "picocolors";
import { STATE_DIR } from "@friday/shared";

/** cloudflared's own user launch agent label. `cloudflared service install`
 *  writes `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist` with this
 *  label and bootstraps it; we query/teardown the same job. */
export const CLOUDFLARED_LAUNCHD_LABEL = "com.cloudflare.cloudflared";

/** Fingerprint of the token last handed to `cloudflared service install`,
 *  persisted so reconcile can detect a rotated vault token (and only then
 *  reinstall). Machine-local runtime state, not user config. */
const INSTALLED_TOKEN_SHA_PATH = join(STATE_DIR, "cloudflared-token.sha256");

export type TunnelAction = "install" | "reinstall" | "uninstall" | "noop";

export interface TunnelDecisionInput {
  /** `config.json` `tunnel.serve === true` — explicit serve-here intent. */
  serve: boolean;
  /** Is a tunnel token present in the vault? */
  hasToken: boolean;
  /** Is the cloudflared launch agent currently loaded in launchd? */
  installed: boolean;
  /** SHA-256 of the token we last installed (from state), or null if unknown
   *  (no state file — e.g. agent installed by a pre-FRI-166 build). */
  installedSha: string | null;
  /** SHA-256 of the current vault token, or null if no token. */
  tokenSha: string | null;
}

/**
 * Pure reconcile decision. The whole truth table lives here so it can be
 * exhaustively tested without subprocesses.
 *
 *   want-to-serve ≡ serve AND hasToken.
 *   - !want-to-serve → tear down if installed, else nothing.
 *   - want-to-serve, not installed → install.
 *   - want-to-serve, installed, KNOWN token mismatch → reinstall (rotation).
 *   - want-to-serve, installed, same/unknown token → nothing (idempotent;
 *     we never bounce a healthy tunnel on a hunch).
 */
export function decideTunnelAction(input: TunnelDecisionInput): TunnelAction {
  const wantServe = input.serve && input.hasToken;
  if (!wantServe) {
    return input.installed ? "uninstall" : "noop";
  }
  if (!input.installed) return "install";
  // Already installed + serving. Reinstall ONLY on a known fingerprint
  // mismatch (token rotated in the vault). If either fingerprint is unknown
  // we leave the running tunnel alone rather than bounce it gratuitously.
  if (input.installedSha && input.tokenSha && input.installedSha !== input.tokenSha) {
    return "reinstall";
  }
  return "noop";
}

export interface ReconcileResult {
  action: TunnelAction;
  /** Did the intended action complete? False on an install/reinstall that
   *  couldn't run (cloudflared missing, or `service install` errored).
   *  Always true for `uninstall`/`noop`. */
  ok: boolean;
  /** Human-readable one-liner describing what happened, for CLI output. */
  detail: string;
  /** True when cloudflared simply isn't on PATH (a soft skip the caller hints
   *  about, distinct from a hard install failure). */
  skipped?: boolean;
}

export interface ReconcileInput {
  serve: boolean;
  token: string | undefined;
}

/**
 * Reconcile the cloudflared launch agent to (serve-intent, token). Idempotent.
 * Returns what it did so callers can print an accurate status line.
 */
export function reconcileTunnel(input: ReconcileInput): ReconcileResult {
  const hasToken = !!input.token;
  const tokenSha = input.token ? sha256(input.token) : null;
  const installed = cloudflaredLoaded();
  const installedSha = readInstalledSha();

  const action = decideTunnelAction({
    serve: input.serve,
    hasToken,
    installed,
    installedSha,
    tokenSha,
  });

  switch (action) {
    case "install":
    case "reinstall": {
      const res = installCloudflared(input.token!);
      if (!res.ok) {
        return { action, ok: false, detail: res.detail, skipped: res.skipped };
      }
      writeInstalledSha(tokenSha!);
      return {
        action,
        ok: true,
        detail:
          action === "install"
            ? "tunnel agent installed"
            : "tunnel agent reinstalled (token rotated)",
      };
    }
    case "uninstall": {
      uninstallCloudflared();
      clearInstalledSha();
      return { action, ok: true, detail: "tunnel agent removed" };
    }
    case "noop":
      return {
        action,
        ok: true,
        detail:
          input.serve && hasToken
            ? "tunnel agent already serving"
            : "tunnel not serving (no serve-intent or no token)",
      };
  }
}

interface InstallResult {
  ok: boolean;
  detail: string;
  /** Set when cloudflared isn't on PATH — a soft skip, not a failure. */
  skipped?: boolean;
}

/**
 * Install (or replace) the cloudflared launch agent for a connector token.
 *
 * Connector-token tunnels need `cloudflared tunnel run --token <T>`. The
 * `homebrew.mxcl.cloudflared` plist that `brew services start cloudflared`
 * would load runs `cloudflared` bare — no args, no token — so it spins on
 * "permission denied" and exits 1. The canonical token-tunnel path is
 * `cloudflared service install <T>`, which writes its own user launch agent
 * (`~/Library/LaunchAgents/com.cloudflare.cloudflared.plist`) and bootstraps
 * it. We sidestep brew's plist entirely.
 *
 * Moved out of `setup.ts` (was `installCloudflaredLaunchAgent`) so both setup
 * and the `start`/`tunnel`/`restore` reconcile share one install path.
 */
export function installCloudflared(token: string): InstallResult {
  const cloudflaredOnPath = spawnSync("which", ["cloudflared"], { stdio: "ignore" }).status === 0;
  if (!cloudflaredOnPath) {
    return {
      ok: false,
      skipped: true,
      detail:
        "cloudflared not on PATH — install with `brew install cloudflared` then re-run `friday setup --cloudflare`",
    };
  }

  // Clean up brew's bare-cloudflared job if a prior install loaded it; the
  // formula's auto-generated plist is incompatible with token tunnels.
  const brewHasCloudflared =
    spawnSync("brew", ["list", "cloudflared"], { stdio: "ignore" }).status === 0;
  if (brewHasCloudflared) {
    spawnSync("brew", ["services", "stop", "cloudflared"], { stdio: "ignore" });
  }

  // Idempotent: replaces any prior `cloudflared service install` (token
  // rotation, re-run setup, etc.). The uninstall is best-effort — it errors
  // out cleanly if nothing is installed, which we don't care about.
  spawnSync("cloudflared", ["service", "uninstall"], { stdio: "ignore" });

  const install = spawnSync("cloudflared", ["service", "install", token], { encoding: "utf8" });
  if (install.status !== 0) {
    const lines = [pc.red("  cloudflared service install failed:")];
    if (install.stderr?.trim()) lines.push(install.stderr.trim());
    if (install.stdout?.trim()) lines.push(install.stdout.trim());
    lines.push(
      pc.dim(
        "  the token is saved in the secrets vault; re-run `friday setup --cloudflare` to retry the launch agent install.",
      ),
    );
    console.error(lines.join("\n"));
    return { ok: false, detail: "cloudflared service install failed" };
  }
  return { ok: true, detail: "cloudflared launch agent installed" };
}

/**
 * Tear down the cloudflared launch agent. Best-effort: `service uninstall`
 * removes the plist + boots the job out; a non-existent agent is not an error
 * worth surfacing. Also boots out any still-loaded job by label as a backstop.
 */
export function uninstallCloudflared(): void {
  const cloudflaredOnPath = spawnSync("which", ["cloudflared"], { stdio: "ignore" }).status === 0;
  if (cloudflaredOnPath) {
    spawnSync("cloudflared", ["service", "uninstall"], { stdio: "ignore" });
  }
  // Backstop: if the job is still loaded (e.g. cloudflared binary gone but the
  // plist lingers), boot it out directly so it stops serving.
  const uid = process.getuid?.() ?? 0;
  spawnSync("launchctl", ["bootout", `gui/${uid}/${CLOUDFLARED_LAUNCHD_LABEL}`], {
    stdio: "ignore",
  });
}

/** True if the cloudflared launch agent is currently loaded in launchd. */
export function cloudflaredLoaded(): boolean {
  const uid = process.getuid?.() ?? 0;
  return (
    spawnSync("launchctl", ["print", `gui/${uid}/${CLOUDFLARED_LAUNCHD_LABEL}`], {
      stdio: ["ignore", "ignore", "ignore"],
    }).status === 0
  );
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function readInstalledSha(): string | null {
  if (!existsSync(INSTALLED_TOKEN_SHA_PATH)) return null;
  try {
    const v = readFileSync(INSTALLED_TOKEN_SHA_PATH, "utf8").trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeInstalledSha(sha: string): void {
  mkdirSync(dirname(INSTALLED_TOKEN_SHA_PATH), { recursive: true });
  writeFileSync(INSTALLED_TOKEN_SHA_PATH, sha + "\n");
}

function clearInstalledSha(): void {
  rmSync(INSTALLED_TOKEN_SHA_PATH, { force: true });
}
