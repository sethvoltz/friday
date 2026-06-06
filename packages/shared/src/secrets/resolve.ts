import type { AgentTypeName } from "../config.js";
import { vaultKeyForMeta } from "./paths.js";
import type { DaemonConfigField, SecretMeta, VaultCache } from "./types.js";
import { DAEMON_FIELD_ALIASES } from "./types.js";
import { getVaultCache } from "./vault.js";

const ENV_VAR_REF = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export function extractEnvVarRefs(...values: (string | undefined)[]): Set<string> {
  const refs = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    for (const m of v.matchAll(ENV_VAR_REF)) {
      refs.add(m[1]);
    }
  }
  return refs;
}

export function collectRefsFromEnvRecords(
  records: Record<string, string>[],
): Set<string> {
  const refs = new Set<string>();
  for (const rec of records) {
    for (const v of Object.values(rec)) {
      for (const m of v.matchAll(ENV_VAR_REF)) refs.add(m[1]);
    }
  }
  return refs;
}

function scopeAllows(meta: SecretMeta, agentType: AgentTypeName, appId?: string): boolean {
  if (meta.daemon) return false;
  if (meta.app !== undefined && meta.app !== appId) return false;
  if (meta.agents && meta.agents.length > 0 && !meta.agents.includes(agentType)) return false;
  return true;
}

export function buildSubstitutionMap(opts: {
  referenced: Set<string>;
  agentType: AgentTypeName;
  appId?: string;
  cache?: VaultCache;
  legacyEnv?: Record<string, string>;
}): Record<string, string> {
  const cache = opts.cache ?? getVaultCache();
  const out: Record<string, string> = {};

  if (opts.legacyEnv) {
    for (const name of opts.referenced) {
      const v = opts.legacyEnv[name];
      if (v) out[name] = v;
    }
  }

  if (!cache) return out;

  for (const meta of cache.meta.secrets) {
    if (meta.mode !== "env") continue;
    if (!scopeAllows(meta, opts.agentType, opts.appId)) continue;
    if (!opts.referenced.has(meta.name)) continue;

    const vaultKey = vaultKeyForMeta(meta);
    const value = cache.payload.secrets[vaultKey]?.value;
    if (value !== undefined) out[meta.name] = value;
  }

  return out;
}

export function resolveDaemonFields(
  cache: VaultCache | undefined,
  envOverride: (key: string) => string | undefined,
): Partial<Record<DaemonConfigField, string>> {
  const out: Partial<Record<DaemonConfigField, string>> = {};
  if (!cache) return out;

  for (const meta of cache.meta.secrets) {
    if (!meta.daemon) continue;
    const field = DAEMON_FIELD_ALIASES[meta.name];
    if (!field) continue;
    const vaultKey = vaultKeyForMeta(meta);
    const fromVault = cache.payload.secrets[vaultKey]?.value;
    const value = envOverride(meta.name) ?? fromVault;
    if (value !== undefined) out[field] = value;
  }
  return out;
}

export function listOnDemandForCaller(opts: {
  agentType: AgentTypeName;
  appId?: string;
  cache?: VaultCache;
}): string[] {
  const cache = opts.cache ?? getVaultCache();
  if (!cache) return [];
  return cache.meta.secrets
    .filter((m) => m.mode === "on-demand" && scopeAllows(m, opts.agentType, opts.appId))
    .map((m) => m.name);
}

export function canFetchOnDemand(opts: {
  name: string;
  agentType: AgentTypeName;
  appId?: string;
  cache?: VaultCache;
}): { ok: true; value: string } | { ok: false; reason: string } {
  const cache = opts.cache ?? getVaultCache();
  if (!cache) return { ok: false, reason: "vault locked" };

  let resolvedMeta: SecretMeta | undefined;
  if (opts.appId) {
    resolvedMeta = cache.meta.secrets.find((m) => m.name === opts.name && m.app === opts.appId);
  }
  if (!resolvedMeta) {
    resolvedMeta = cache.meta.secrets.find((m) => m.name === opts.name && !m.app);
  }
  if (!resolvedMeta) return { ok: false, reason: "unknown secret" };
  if (resolvedMeta.mode !== "on-demand") return { ok: false, reason: "not on-demand" };
  if (resolvedMeta.daemon) return { ok: false, reason: "daemon secret" };
  if (!scopeAllows(resolvedMeta, opts.agentType, opts.appId)) return { ok: false, reason: "scope denied" };

  const vaultKey = vaultKeyForMeta(resolvedMeta);
  const value = cache.payload.secrets[vaultKey]?.value;
  if (value === undefined) return { ok: false, reason: "missing value" };
  return { ok: true, value };
}

export function metaForVaultKeys(cache: VaultCache): Map<string, SecretMeta> {
  const map = new Map<string, SecretMeta>();
  for (const m of cache.meta.secrets) {
    map.set(vaultKeyForMeta(m), m);
  }
  return map;
}

export function legacyAppEnvToSubstitution(
  appId: string,
  legacy: Record<string, string>,
  referenced: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of referenced) {
    if (legacy[name]) out[name] = legacy[name];
  }
  return out;
}
