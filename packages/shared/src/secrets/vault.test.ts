import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAgeKeypair } from "./age.js";
import { readMetaFile, validateBijection } from "./meta.js";
import { AGE_KEY_PATH, GENERATION_PATH, META_PATH, SECRETS_DIR, VAULT_ENC_PATH } from "./paths.js";
import { clearSecretsCache, initVault, removeSecret, unlockVault, upsertSecret } from "./vault.js";

describe("vault transactional writes", () => {
  beforeEach(() => {
    if (existsSync(SECRETS_DIR)) rmSync(SECRETS_DIR, { recursive: true, force: true });
    clearSecretsCache();
  });

  afterEach(() => {
    clearSecretsCache();
    if (existsSync(SECRETS_DIR)) rmSync(SECRETS_DIR, { recursive: true, force: true });
    if (existsSync(AGE_KEY_PATH)) rmSync(AGE_KEY_PATH, { force: true });
  });

  it("init → set → unlock round-trip", async () => {
    const { identity, recipient } = await generateAgeKeypair();
    await initVault(identity, recipient);
    expect(existsSync(VAULT_ENC_PATH)).toBe(true);
    expect(existsSync(META_PATH)).toBe(true);
    chmodSync(AGE_KEY_PATH, 0o600);

    await upsertSecret({ name: "TEST_KEY", mode: "env" }, "value123");
    const unlock = await unlockVault(true);
    expect(unlock.ok).toBe(true);
    if (unlock.ok) {
      expect(unlock.cache.payload.secrets.TEST_KEY?.value).toBe("value123");
      const bio = validateBijection(
        unlock.cache.meta,
        new Set(Object.keys(unlock.cache.payload.secrets)),
      );
      expect(bio.ok).toBe(true);
    }
    expect(existsSync(GENERATION_PATH)).toBe(true);
  });

  it("removeSecret drops meta and vault entry", async () => {
    const { identity, recipient } = await generateAgeKeypair();
    await initVault(identity, recipient);
    await upsertSecret({ name: "DROP_ME", mode: "env" }, "x");
    await removeSecret("DROP_ME");
    const meta = readMetaFile();
    expect(meta.secrets.find((s) => s.name === "DROP_ME")).toBeUndefined();
    const unlock = await unlockVault(true);
    expect(unlock.ok).toBe(true);
    if (unlock.ok) expect(unlock.cache.payload.secrets.DROP_ME).toBeUndefined();
  });
});
