import { join } from "node:path";
import { DATA_DIR } from "../config.js";

export const SECRETS_DIR = join(DATA_DIR, "secrets");
export const VAULT_ENC_PATH = join(SECRETS_DIR, "vault.enc");
export const META_PATH = join(SECRETS_DIR, "meta.yaml");
export const RECIPIENTS_PATH = join(SECRETS_DIR, "recipients.txt");
export const GENERATION_PATH = join(SECRETS_DIR, ".generation");
export const AGE_KEY_PATH = join(DATA_DIR, ".age-key");

/** Legacy path — migration reads then scrubs. */
export const ENV_LEGACY_PATH = join(DATA_DIR, ".env");

export function vaultKeyForMeta(meta: { name: string; app?: string }): string {
  return meta.app ? `apps/${meta.app}/${meta.name}` : meta.name;
}

export function shortNameFromVaultKey(vaultKey: string, appId?: string): string | undefined {
  if (appId) {
    const prefix = `apps/${appId}/`;
    if (vaultKey.startsWith(prefix)) return vaultKey.slice(prefix.length);
    return undefined;
  }
  if (vaultKey.startsWith("apps/")) return undefined;
  return vaultKey;
}
