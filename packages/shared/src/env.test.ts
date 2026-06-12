// Regression for the FRI-166 cutover bug: a daemon-scoped integration secret
// (CLOUDFLARE_TUNNEL_TOKEN) lives in the age vault, and `loadFridayConfig()`
// resolves it from the IN-MEMORY vault cache (`getVaultCache()`). That cache is
// only populated by `warmVaultCache()`/`unlockVault()` — which the daemon does
// at boot but a fresh CLI process does NOT. So `friday start` / `friday tunnel`
// read the token as ABSENT even when it's present in a perfectly-restored
// vault, and the tunnel reconcile silently serves nothing. The fix warms the
// vault once at CLI entry (index.ts `setup`) so every command's read resolves.
// This test pins the contract that fix relies on — a daemon-scoped vault token
// is invisible to loadFridayConfig() while locked, and visible after warming.

import { chmodSync, existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAgeKeypair } from "./secrets/age.js";
import { AGE_KEY_PATH, SECRETS_DIR } from "./secrets/paths.js";
import { clearSecretsCache, initVault, upsertSecret } from "./secrets/vault.js";
import { clearFridayConfigCache, loadFridayConfig, warmVaultCache } from "./env.js";

const TOKEN = "cf-tunnel-token-abc123xyz";

describe("loadFridayConfig + vault warm (FRI-166 regression)", () => {
  beforeEach(() => {
    delete process.env.CLOUDFLARE_TUNNEL_TOKEN; // ensure the vault is the only source
    if (existsSync(SECRETS_DIR)) rmSync(SECRETS_DIR, { recursive: true, force: true });
    if (existsSync(AGE_KEY_PATH)) rmSync(AGE_KEY_PATH, { force: true });
    clearSecretsCache();
    clearFridayConfigCache();
  });

  afterEach(() => {
    if (existsSync(SECRETS_DIR)) rmSync(SECRETS_DIR, { recursive: true, force: true });
    if (existsSync(AGE_KEY_PATH)) rmSync(AGE_KEY_PATH, { force: true });
    clearSecretsCache();
    clearFridayConfigCache();
  });

  it("a daemon-scoped vault token is INVISIBLE until the vault is warmed, then resolves", async () => {
    const { identity, recipient } = await generateAgeKeypair();
    await initVault(identity, recipient);
    chmodSync(AGE_KEY_PATH, 0o600);
    await upsertSecret({ name: "CLOUDFLARE_TUNNEL_TOKEN", mode: "env", daemon: true }, TOKEN);

    // Simulate a fresh CLI process: vault locked, config cache empty.
    clearSecretsCache();
    clearFridayConfigCache();

    // The bug: without warming, the token reads as absent even though the
    // vault on disk holds it. (`friday start` hit exactly this.)
    expect(loadFridayConfig().cloudflareTunnelToken).toBeUndefined();

    // The fix: warm the vault (non-interactive via the age key on disk), drop
    // the config cache built from the locked vault, re-read.
    await warmVaultCache();
    clearFridayConfigCache();

    expect(loadFridayConfig().cloudflareTunnelToken).toBe(TOKEN);
  });
});
