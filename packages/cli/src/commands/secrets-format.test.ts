import { describe, expect, it } from "vitest";
import {
  buildSecretRows,
  renderSecretsList,
  type SecretListRow,
  type SecretMetaInput,
} from "./secrets-format.js";

// picocolors may or may not emit escape codes depending on the runner's TTY /
// FORCE_COLOR state. Strip them so assertions pin layout, not color.
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/gu, "");

const ROWS: SecretListRow[] = [
  { name: "LINEAR_API_KEY", mode: "env", scope: ["daemon"], broken: false },
  { name: "TRMNL_KITCHEN_WEBHOOK", mode: "env", scope: ["app=kitchen"], broken: false },
  { name: "SECRET_X", mode: "on-demand", scope: ["agents=builder,helper"], broken: true },
  { name: "PLAIN", mode: "env", scope: [], broken: false },
];

describe("buildSecretRows — broken detection", () => {
  const META: SecretMetaInput[] = [
    { name: "PRESENT", mode: "env", daemon: true },
    { name: "ORPHAN", mode: "env" },
    { name: "SCOPED", mode: "on-demand", app: "kitchen" },
  ];
  // PRESENT + SCOPED have vault values; ORPHAN does not.
  const VAULT = new Set(["PRESENT", "apps/kitchen/SCOPED"]);

  it("flags ONLY the orphaned row — one orphan must not smear across healthy rows", () => {
    const rows = buildSecretRows(META, VAULT, { unlocked: true });
    expect(rows.map((r) => [r.name, r.broken])).toEqual([
      ["PRESENT", false],
      ["ORPHAN", true],
      ["SCOPED", false],
    ]);
  });

  it("flags nothing when the vault is locked (brokenness is unverifiable)", () => {
    // Locked ⇒ caller passes an empty vaultKeys set + unlocked:false.
    const rows = buildSecretRows(META, new Set<string>(), { unlocked: false });
    expect(rows.every((r) => r.broken === false)).toBe(true);
  });

  it("keys an app-scoped secret by `apps/<app>/<name>`, not its bare name", () => {
    // Bare name in the vault must NOT satisfy an app-scoped meta entry.
    const rows = buildSecretRows(
      [{ name: "SCOPED", mode: "env", app: "kitchen" }],
      new Set(["SCOPED"]),
      {
        unlocked: true,
      },
    );
    expect(rows[0].broken).toBe(true);
  });

  it("assembles scope tags in order: daemon, app, agents", () => {
    const rows = buildSecretRows(
      [{ name: "K", mode: "env", daemon: true, app: "kitchen", agents: ["builder", "helper"] }],
      new Set(["apps/kitchen/K"]),
      { unlocked: true },
    );
    expect(rows[0].scope).toEqual(["daemon", "app=kitchen", "agents=builder,helper"]);
  });

  it("filters by app id when opts.app is set", () => {
    const rows = buildSecretRows(META, VAULT, { unlocked: true, app: "kitchen" });
    expect(rows.map((r) => r.name)).toEqual(["SCOPED"]);
  });
});

describe("renderSecretsList — non-interactive (tty: false)", () => {
  it("emits one tab-separated record per row with a stable 4-column shape", () => {
    const lines = renderSecretsList(ROWS, { tty: false });
    expect(lines).toEqual([
      "LINEAR_API_KEY\tenv\tdaemon\tok",
      "TRMNL_KITCHEN_WEBHOOK\tenv\tapp=kitchen\tok",
      "SECRET_X\ton-demand\tagents=builder,helper\tbroken",
      "PLAIN\tenv\t\tok",
    ]);
  });

  it("emits NO header and NO color codes (pipe-safe)", () => {
    const lines = renderSecretsList(ROWS, { tty: false });
    expect(lines.some((l) => l.includes("NAME"))).toBe(false);
    expect(lines.every((l) => l === strip(l))).toBe(true);
    // Every row carries exactly four tab-delimited fields.
    expect(lines.every((l) => l.split("\t").length === 4)).toBe(true);
  });

  it("joins multiple scope tags with a comma in the scope field", () => {
    const lines = renderSecretsList(
      [{ name: "K", mode: "env", scope: ["daemon", "app=kitchen"], broken: false }],
      { tty: false },
    );
    expect(lines[0]).toBe("K\tenv\tdaemon,app=kitchen\tok");
  });

  it("returns nothing for an empty list (clean pipe)", () => {
    expect(renderSecretsList([], { tty: false })).toEqual([]);
  });
});

describe("renderSecretsList — interactive (tty: true)", () => {
  it("right-pads NAME and MODE so columns align to the widest cell", () => {
    const lines = renderSecretsList(ROWS, { tty: true }).map(strip);
    // nameW = len("TRMNL_KITCHEN_WEBHOOK") = 21; modeW = len("on-demand") = 9.
    expect(lines).toEqual([
      "  NAME                   MODE       SCOPE",
      "  LINEAR_API_KEY         env        daemon",
      "  TRMNL_KITCHEN_WEBHOOK  env        app=kitchen",
      "  SECRET_X               on-demand  agents=builder,helper  broken",
      "  PLAIN                  env        —",
    ]);
  });

  it("aligns the MODE header over the MODE column", () => {
    const lines = renderSecretsList(ROWS, { tty: true }).map(strip);
    const modeCol = lines[0].indexOf("MODE");
    expect(lines[1].slice(modeCol).startsWith("env")).toBe(true);
    expect(lines[3].slice(modeCol).startsWith("on-demand")).toBe(true);
  });

  it("marks a broken row with a trailing `broken` tag, others without", () => {
    const lines = renderSecretsList(ROWS, { tty: true }).map(strip);
    expect(lines[3].endsWith("broken")).toBe(true); // SECRET_X
    expect(lines.filter((l) => l.endsWith("broken"))).toHaveLength(1);
  });

  it("renders an em-dash placeholder for an unscoped secret", () => {
    const lines = renderSecretsList(ROWS, { tty: true }).map(strip);
    expect(lines[4]).toBe("  PLAIN                  env        —");
  });

  it("shows a dim placeholder line for an empty list", () => {
    expect(renderSecretsList([], { tty: true }).map(strip)).toEqual(["  no secrets stored"]);
  });
});
