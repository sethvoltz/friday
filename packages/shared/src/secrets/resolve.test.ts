import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSubstitutionMap,
  canFetchOnDemand,
  collectRefsFromEnvRecords,
  listOnDemandForCaller,
  resolveDaemonFields,
} from "./resolve.js";
import type { VaultCache } from "./types.js";
import { clearSecretsCache } from "./vault.js";

const cache: VaultCache = {
  generation: "1",
  meta: {
    secrets: [
      { name: "GITHUB_TOKEN", mode: "env" },
      { name: "LINEAR_API_KEY", mode: "env", daemon: true },
      { name: "MEALIE_API_KEY", mode: "env", app: "kitchen" },
      { name: "ADMIN_PASSWORD", mode: "on-demand", agents: ["orchestrator", "builder"] },
      { name: "DAEMON_ONLY", mode: "on-demand", daemon: true },
    ],
  },
  payload: {
    version: 1,
    secrets: {
      GITHUB_TOKEN: { value: "gho_abc" },
      LINEAR_API_KEY: { value: "lin_abc" },
      "apps/kitchen/MEALIE_API_KEY": { value: "mealie_abc" },
      ADMIN_PASSWORD: { value: "secret" },
      DAEMON_ONLY: { value: "nope" },
    },
  },
};

describe("buildSubstitutionMap", () => {
  afterEach(() => clearSecretsCache());

  it("injects only referenced env-mode secrets in scope", () => {
    const map = buildSubstitutionMap({
      referenced: new Set(["GITHUB_TOKEN", "MEALIE_API_KEY", "LINEAR_API_KEY"]),
      agentType: "builder",
      appId: "kitchen",
      cache,
    });
    expect(map.GITHUB_TOKEN).toBe("gho_abc");
    expect(map.MEALIE_API_KEY).toBe("mealie_abc");
    expect(map.LINEAR_API_KEY).toBeUndefined();
  });

  it("excludes unreferenced secrets", () => {
    const map = buildSubstitutionMap({
      referenced: new Set(["GITHUB_TOKEN"]),
      agentType: "orchestrator",
      cache,
    });
    expect(map.GITHUB_TOKEN).toBe("gho_abc");
    expect(Object.keys(map)).toHaveLength(1);
  });

  it("merges legacy app env for referenced keys", () => {
    const map = buildSubstitutionMap({
      referenced: new Set(["LEGACY_KEY"]),
      agentType: "bare",
      appId: "kitchen",
      cache,
      legacyEnv: { LEGACY_KEY: "from-dotenv" },
    });
    expect(map.LEGACY_KEY).toBe("from-dotenv");
  });
});

describe("resolveDaemonFields", () => {
  it("maps daemon-flagged secrets to typed fields", () => {
    const fields = resolveDaemonFields(cache, () => undefined);
    expect(fields.linearApiKey).toBe("lin_abc");
  });

  it("prefers process.env override when supplied", () => {
    const fields = resolveDaemonFields(cache, (k) =>
      k === "LINEAR_API_KEY" ? "override" : undefined,
    );
    expect(fields.linearApiKey).toBe("override");
  });
});

describe("on-demand fetch scope", () => {
  it("lists on-demand names for caller scope", () => {
    const names = listOnDemandForCaller({ agentType: "builder", cache });
    expect(names).toEqual(["ADMIN_PASSWORD"]);
  });

  it("rejects env-mode and daemon secrets on fetch", () => {
    expect(canFetchOnDemand({ name: "GITHUB_TOKEN", agentType: "builder", cache }).ok).toBe(false);
    expect(canFetchOnDemand({ name: "DAEMON_ONLY", agentType: "orchestrator", cache }).ok).toBe(
      false,
    );
  });

  it("allows scoped on-demand fetch", () => {
    const r = canFetchOnDemand({ name: "ADMIN_PASSWORD", agentType: "builder", cache });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("secret");
  });
});

describe("collectRefsFromEnvRecords", () => {
  it("extracts ${VAR} references", () => {
    const refs = collectRefsFromEnvRecords([{ TOKEN: "${GITHUB_TOKEN}", X: "plain" }]);
    expect([...refs]).toEqual(["GITHUB_TOKEN"]);
  });
});
