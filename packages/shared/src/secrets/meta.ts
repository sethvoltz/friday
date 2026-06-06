import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentTypeName } from "../config.js";
import { META_PATH } from "./paths.js";
import { vaultKeyForMeta } from "./paths.js";
import type { SecretMeta, SecretsMetaFile, VaultPayload } from "./types.js";

const VALID_MODES = new Set(["env", "on-demand"]);
const VALID_AGENTS = new Set<AgentTypeName>([
  "orchestrator",
  "builder",
  "helper",
  "scheduled",
  "bare",
  "planner",
]);

export function emptyMeta(): SecretsMetaFile {
  return { secrets: [] };
}

export function readMetaFile(): SecretsMetaFile {
  try {
    const raw = readFileSync(META_PATH, "utf8");
    const parsed = parseYaml(raw) as SecretsMetaFile | null;
    if (!parsed || !Array.isArray(parsed.secrets)) return emptyMeta();
    return { secrets: parsed.secrets.filter(isValidMetaEntry) };
  } catch {
    return emptyMeta();
  }
}

function isValidMetaEntry(entry: unknown): entry is SecretMeta {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as SecretMeta;
  if (typeof e.name !== "string" || !e.name) return false;
  if (!VALID_MODES.has(e.mode)) return false;
  if (e.app !== undefined && typeof e.app !== "string") return false;
  if (e.daemon !== undefined && typeof e.daemon !== "boolean") return false;
  if (e.agents !== undefined) {
    if (!Array.isArray(e.agents)) return false;
    if (!e.agents.every((a) => VALID_AGENTS.has(a as AgentTypeName))) return false;
  }
  return true;
}

export function writeMetaFile(meta: SecretsMetaFile): void {
  writeFileSync(META_PATH, stringifyYaml(meta), "utf8");
}

export function findMeta(meta: SecretsMetaFile, name: string, app?: string): SecretMeta | undefined {
  return meta.secrets.find((s) => s.name === name && (s.app ?? undefined) === (app ?? undefined));
}

export function validateBijection(
  meta: SecretsMetaFile,
  vaultKeys: Set<string>,
): { ok: boolean; orphanMeta: string[]; orphanVault: string[] } {
  const metaKeys = new Set(meta.secrets.map((s) => vaultKeyForMeta(s)));
  const orphanMeta: string[] = [];
  const orphanVault: string[] = [];
  for (const k of metaKeys) {
    if (!vaultKeys.has(k)) orphanMeta.push(k);
  }
  for (const k of vaultKeys) {
    if (!metaKeys.has(k)) orphanVault.push(k);
  }
  return { ok: orphanMeta.length === 0 && orphanVault.length === 0, orphanMeta, orphanVault };
}
