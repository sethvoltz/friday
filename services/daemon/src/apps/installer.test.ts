/**
 * Friday Apps installer tests (FRI-78).
 *
 * Covers the §16 acceptance criteria against the synthetic fixture in
 * src/apps/fixtures/example-app. The lifecycle.archiveAgent path is
 * mocked because exercising it would fork real worker processes — we
 * verify the *registry* state after uninstall, which is what callers
 * observe.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "friday-apps-installer-"));
process.env.FRIDAY_DATA_DIR = dataDir;

vi.mock("../agent/lifecycle.js", () => ({
  archiveAgent: vi.fn(async () => []),
}));

const { runMigrations, closeDb, getRawDb, getDb, schema, appDir } = await import(
  "@friday/shared"
);
const registry = await import("../agent/registry.js");
const {
  AppInstallError,
  installApp,
  inspectApp,
  listApps,
  reloadApp,
  uninstallApp,
} = await import("./installer.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = resolve(__dirname, "fixtures/example-app");

function freshFixture(id = "example-app"): string {
  const target = appDir(id);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  cpSync(FIXTURE_SRC, target, { recursive: true });
  // Rewrite manifest id if a non-default id is requested.
  if (id !== "example-app") {
    const manifestPath = join(target, "manifest.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    m.id = id;
    writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  }
  return target;
}

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const raw = getRawDb();
  raw.prepare("DELETE FROM blocks").run();
  raw.prepare("DELETE FROM schedules").run();
  raw.prepare("DELETE FROM agents").run();
  raw.prepare("DELETE FROM apps").run();
  // Clean up any pre-existing app folders from prior tests
  const appsRoot = appDir("");
  if (existsSync(appsRoot)) rmSync(appsRoot, { recursive: true, force: true });
});

describe("installApp", () => {
  it("registers agents + schedules + app row from the fixture", () => {
    const folder = freshFixture();
    const result = installApp(folder);
    expect(result.id).toBe("example-app");
    expect(result.status).toBe("installed");
    expect(result.agents).toEqual([
      { name: "example-owner", type: "bare" },
      { name: "example-weekly", type: "scheduled" },
    ]);
    expect(result.schedules).toEqual([
      { name: "example-weekly-run", cron: "0 4 * * 1" },
    ]);
    expect(result.mcpServers).toEqual([{ name: "example-echo" }]);

    const owner = registry.getAgent("example-owner");
    expect(owner).not.toBeNull();
    expect(owner!.type).toBe("bare");
    expect(owner!.status).toBe("idle");
    expect(registry.getAppId("example-owner")).toBe("example-app");

    const weekly = registry.getAgent("example-weekly");
    expect(weekly!.type).toBe("scheduled");
    expect(registry.getAppId("example-weekly")).toBe("example-app");

    const db = getDb();
    const sched = db.select().from(schema.schedules).all();
    expect(sched).toHaveLength(1);
    expect(sched[0].name).toBe("example-weekly-run");
    expect(sched[0].appId).toBe("example-app");
  });

  it("drops a default .gitignore on fresh install", () => {
    const folder = freshFixture();
    installApp(folder);
    const gi = readFileSync(join(folder, ".gitignore"), "utf8");
    expect(gi).toContain(".env");
    expect(gi).toContain("state/*.cache.json");
  });

  it("rejects double-install without going through reload", () => {
    const folder = freshFixture();
    installApp(folder);
    expect(() => installApp(folder)).toThrowError(/already installed/);
  });

  it("acceptance §16.6: name collision fails with no DB writes when adopt=false", () => {
    // Pre-create an unaffiliated agent with the same name
    registry.registerAgent({ name: "example-owner", type: "bare" });
    const folder = freshFixture();

    const db = getDb();
    const beforeApps = db.select().from(schema.apps).all().length;
    const beforeAgents = db.select().from(schema.agents).all().length;
    const beforeSchedules = db.select().from(schema.schedules).all().length;

    expect(() => installApp(folder)).toThrow(AppInstallError);

    const afterApps = db.select().from(schema.apps).all().length;
    const afterAgents = db.select().from(schema.agents).all().length;
    const afterSchedules = db.select().from(schema.schedules).all().length;

    expect(afterApps).toBe(beforeApps);
    expect(afterAgents).toBe(beforeAgents);
    expect(afterSchedules).toBe(beforeSchedules);
    // appId still null on the pre-existing row
    expect(registry.getAppId("example-owner")).toBeNull();
  });

  it("acceptance §16.6: adopt=true rebinds an existing agent", () => {
    registry.registerAgent({ name: "example-owner", type: "bare" });
    const folder = freshFixture();
    installApp(folder, { adopt: true });
    expect(registry.getAppId("example-owner")).toBe("example-app");
  });

  it("acceptance §16.6: archived existing row, adopt=false → un-archive + clearSession (history preserved as old session)", () => {
    // Simulate the prior incarnation: the agent existed and ran, then was archived.
    registry.registerAgent({ name: "example-owner", type: "bare" });
    registry.setSession("example-owner", "sess-old-12345");
    registry.archiveAgent("example-owner");

    const folder = freshFixture();
    installApp(folder);

    const row = registry.getAgent("example-owner");
    expect(row!.status).toBe("idle");
    expect(registry.getAppId("example-owner")).toBe("example-app");
    // clearSession on no-adopt reinstall
    expect(row!.sessionId).toBeUndefined();
  });

  it("same-app reinstall (archived rows) un-archives and keeps sessionId", () => {
    const folder = freshFixture();
    installApp(folder);
    registry.setSession("example-owner", "sess-keep-me");
    // Simulate uninstall: archive the agent (tombstone keeps appId)
    registry.archiveAgent("example-owner");
    // Reinstall: must un-archive and preserve sessionId
    // But first we need to drop the apps row that already exists from the
    // first install (uninstallApp would normally do this; we shortcut).
    getRawDb().prepare("DELETE FROM apps WHERE id = ?").run("example-app");
    installApp(folder);
    const row = registry.getAgent("example-owner");
    expect(row!.status).toBe("idle");
    expect(row!.sessionId).toBe("sess-keep-me");
  });

  it("rejects manifests whose mcpServer name collides across apps", () => {
    const folderA = freshFixture("app-a");
    installApp(folderA);
    // Build a second fixture with a clashing mcpServer name
    const folderB = freshFixture("app-b");
    const manifestPath = join(folderB, "manifest.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    // Mcp name kept identical (`example-echo`) — distinct app id + agents though
    m.agents = [{ name: "app-b-owner", type: "bare" }];
    m.schedules = [];
    writeFileSync(manifestPath, JSON.stringify(m));
    expect(() => installApp(folderB)).toThrowError(/already declared/);
  });
});

describe("uninstallApp", () => {
  it("archives owned agents, drops schedules, and renames the folder", () => {
    const folder = freshFixture();
    installApp(folder);
    const result = uninstallApp("example-app");
    expect(result.folderDisposition).toBe("archive");
    expect(result.archivedFolderPath).toBeDefined();
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(result.archivedFolderPath!)).toBe(true);

    // App row gone
    const db = getDb();
    expect(db.select().from(schema.apps).all()).toHaveLength(0);
    // Schedules dropped
    expect(db.select().from(schema.schedules).all()).toHaveLength(0);
    // Agents kept (preserve-over-delete); status will be archived
    // once lifecycle.archiveAgent runs — our mock no-ops, so we just
    // verify the tombstoned appId is intact.
    expect(registry.getAppId("example-owner")).toBe("example-app");
  });

  it("folderDisposition=keep leaves the folder in place", () => {
    const folder = freshFixture();
    installApp(folder);
    uninstallApp("example-app", { folderDisposition: "keep" });
    expect(existsSync(folder)).toBe(true);
  });

  it("folderDisposition=delete removes the folder", () => {
    const folder = freshFixture();
    installApp(folder);
    uninstallApp("example-app", { folderDisposition: "delete" });
    expect(existsSync(folder)).toBe(false);
  });

  it("throws on missing app", () => {
    expect(() => uninstallApp("does-not-exist")).toThrowError(/not installed/);
  });
});

describe("reloadApp", () => {
  it("no-ops when manifest unchanged", () => {
    const folder = freshFixture();
    installApp(folder);
    const r = reloadApp("example-app");
    expect(r.changed).toBe(false);
  });

  it("flips status to orphaned when folder disappears", () => {
    const folder = freshFixture();
    installApp(folder);
    rmSync(folder, { recursive: true, force: true });
    const r = reloadApp("example-app");
    expect(r.changed).toBe(true);
    const detail = inspectApp("example-app");
    expect(detail!.status).toBe("orphaned");
  });

  it("picks up new agents added to the manifest", () => {
    const folder = freshFixture();
    installApp(folder);
    const manifestPath = join(folder, "manifest.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    m.agents.push({ name: "example-extra", type: "bare" });
    m.version = "0.2.0";
    writeFileSync(manifestPath, JSON.stringify(m));
    const r = reloadApp("example-app");
    expect(r.changed).toBe(true);
    expect(registry.getAgent("example-extra")).not.toBeNull();
    expect(registry.getAppId("example-extra")).toBe("example-app");
  });

  it("does NOT auto-archive agents removed from the manifest", () => {
    const folder = freshFixture();
    installApp(folder);
    const manifestPath = join(folder, "manifest.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    m.agents = m.agents.filter(
      (a: { name: string }) => a.name !== "example-weekly",
    );
    m.schedules = [];
    writeFileSync(manifestPath, JSON.stringify(m));
    reloadApp("example-app");
    // Weekly agent still present, still owned (preserve-over-delete)
    expect(registry.getAgent("example-weekly")).not.toBeNull();
  });
});

describe("listApps / inspectApp", () => {
  it("lists installed apps; inspect returns full detail or null", () => {
    expect(listApps()).toHaveLength(0);
    const folder = freshFixture();
    installApp(folder);
    const all = listApps();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("example-app");

    const detail = inspectApp("example-app");
    expect(detail).not.toBeNull();
    expect(detail!.manifest.id).toBe("example-app");
    expect(detail!.agents.map((a) => a.name).sort()).toEqual([
      "example-owner",
      "example-weekly",
    ]);
    expect(detail!.schedules.map((s) => s.name)).toEqual(["example-weekly-run"]);
    expect(detail!.mcpServers.map((m) => m.name)).toEqual(["example-echo"]);

    expect(inspectApp("ghost")).toBeNull();
  });
});
