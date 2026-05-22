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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// MUST set FRIDAY_DATA_DIR before any @friday/shared import — APPS_DIR is
// captured at module evaluation. Without this guard, the rmSync(appDir(""))
// calls below target the real ~/.friday/apps/ and silently wipe user data.
// See CLAUDE.md "Testing discipline" and the May 2026 Kitchen-app incident.
const FRIDAY_DATA_DIR = mkdtempSync(join(tmpdir(), "friday-apps-installer-"));
process.env.FRIDAY_DATA_DIR = FRIDAY_DATA_DIR;

type SharedModule = typeof import("@friday/shared");
let createTestDb: SharedModule["createTestDb"];
let handle: Awaited<ReturnType<SharedModule["createTestDb"]>>;
let getDb: SharedModule["getDb"];
let schema: SharedModule["schema"];
let appDir: SharedModule["appDir"];
let registry: typeof import("../agent/registry.js");
let AppInstallError: (typeof import("./installer.js"))["AppInstallError"];
let installApp: (typeof import("./installer.js"))["installApp"];
let inspectApp: (typeof import("./installer.js"))["inspectApp"];
let listApps: (typeof import("./installer.js"))["listApps"];
let reloadApp: (typeof import("./installer.js"))["reloadApp"];
let uninstallApp: (typeof import("./installer.js"))["uninstallApp"];

vi.mock("../agent/lifecycle.js", () => ({
  archiveAgent: vi.fn(async () => []),
}));

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

beforeAll(async () => {
  ({ createTestDb, getDb, schema, appDir } = await import("@friday/shared"));
  handle = await createTestDb({ label: "apps_installer" });
  registry = await import("../agent/registry.js");
  ({ AppInstallError, installApp, inspectApp, listApps, reloadApp, uninstallApp } =
    await import("./installer.js"));
});

afterAll(async () => {
  await handle.drop();
  // Tear down the scoped FRIDAY_DATA_DIR tmp tree, including the apps folder
  // we created under it. We delete the whole DATA_DIR — appDir("") would also
  // work, but removing the tmp root is more explicit about what we own.
  if (existsSync(FRIDAY_DATA_DIR)) {
    rmSync(FRIDAY_DATA_DIR, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await handle.truncate();
  // Clean up any pre-existing app folders from prior tests
  const appsRoot = appDir("");
  if (existsSync(appsRoot)) rmSync(appsRoot, { recursive: true, force: true });
});

describe("installApp", () => {
  it("registers agents + schedules + app row from the fixture", async () => {
    const folder = freshFixture();
    const result = await installApp(folder);
    expect(result.id).toBe("example-app");
    expect(result.status).toBe("installed");
    expect(result.agents).toEqual([
      { name: "example-owner", type: "bare" },
      { name: "example-weekly", type: "scheduled" },
    ]);
    expect(result.schedules).toEqual([{ name: "example-weekly-run", cron: "0 4 * * 1" }]);
    expect(result.mcpServers).toEqual([{ name: "example-echo" }]);

    const owner = await registry.getAgent("example-owner");
    expect(owner).not.toBeNull();
    expect(owner!.type).toBe("bare");
    expect(owner!.status).toBe("idle");
    expect(await registry.getAppId("example-owner")).toBe("example-app");

    const weekly = await registry.getAgent("example-weekly");
    expect(weekly!.type).toBe("scheduled");
    expect(await registry.getAppId("example-weekly")).toBe("example-app");

    const db = getDb();
    const sched = await db.select().from(schema.schedules);
    expect(sched).toHaveLength(1);
    expect(sched[0].name).toBe("example-weekly-run");
    expect(sched[0].appId).toBe("example-app");
  });

  it("drops a default .gitignore on fresh install", async () => {
    const folder = freshFixture();
    await installApp(folder);
    const gi = readFileSync(join(folder, ".gitignore"), "utf8");
    expect(gi).toContain(".env");
    expect(gi).toContain("state/*.cache.json");
  });

  it("rejects double-install without going through reload", async () => {
    const folder = freshFixture();
    await installApp(folder);
    await expect(installApp(folder)).rejects.toThrow(/already installed/);
  });

  it("double-install throws AppInstallError with code already_installed", async () => {
    const folder = freshFixture();
    await installApp(folder);
    let caught: unknown;
    try {
      await installApp(folder);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppInstallError);
    expect((caught as InstanceType<typeof AppInstallError>).code).toBe("already_installed");
  });

  it("acceptance §16.6: name collision fails with no DB writes when adopt=false", async () => {
    // Pre-create an unaffiliated agent with the same name
    await registry.registerAgent({ name: "example-owner", type: "bare" });
    const folder = freshFixture();

    const db = getDb();
    const beforeApps = (await db.select().from(schema.apps)).length;
    const beforeAgents = (await db.select().from(schema.agents)).length;
    const beforeSchedules = (await db.select().from(schema.schedules)).length;

    await expect(installApp(folder)).rejects.toBeInstanceOf(AppInstallError);

    const afterApps = (await db.select().from(schema.apps)).length;
    const afterAgents = (await db.select().from(schema.agents)).length;
    const afterSchedules = (await db.select().from(schema.schedules)).length;

    expect(afterApps).toBe(beforeApps);
    expect(afterAgents).toBe(beforeAgents);
    expect(afterSchedules).toBe(beforeSchedules);
    // appId still null on the pre-existing row
    expect(await registry.getAppId("example-owner")).toBeNull();
  });

  it("acceptance §16.6: adopt=true rebinds an existing agent", async () => {
    await registry.registerAgent({ name: "example-owner", type: "bare" });
    const folder = freshFixture();
    await installApp(folder, { adopt: true });
    expect(await registry.getAppId("example-owner")).toBe("example-app");
  });

  it("acceptance §16.6: archived existing row, adopt=false → un-archive + clearSession (history preserved as old session)", async () => {
    // Simulate the prior incarnation: the agent existed and ran, then was archived.
    await registry.registerAgent({ name: "example-owner", type: "bare" });
    await registry.setSession("example-owner", "sess-old-12345");
    await registry.archiveAgent("example-owner", { reason: "abandoned" });

    const folder = freshFixture();
    await installApp(folder);

    const row = await registry.getAgent("example-owner");
    expect(row!.status).toBe("idle");
    expect(await registry.getAppId("example-owner")).toBe("example-app");
    // clearSession on no-adopt reinstall
    expect(row!.sessionId).toBeUndefined();
  });

  it("same-app reinstall (archived rows) un-archives and keeps sessionId", async () => {
    const folder = freshFixture();
    await installApp(folder);
    await registry.setSession("example-owner", "sess-keep-me");
    // Simulate uninstall: archive the agent (tombstone keeps appId)
    await registry.archiveAgent("example-owner", { reason: "abandoned" });
    // Reinstall: must un-archive and preserve sessionId
    // But first we need to drop the apps row that already exists from the
    // first install (uninstallApp would normally do this; we shortcut).
    const { eq } = await import("drizzle-orm");
    await getDb().delete(schema.apps).where(eq(schema.apps.id, "example-app"));
    await installApp(folder);
    const row = await registry.getAgent("example-owner");
    expect(row!.status).toBe("idle");
    expect(row!.sessionId).toBe("sess-keep-me");
  });

  it("rejects manifests whose mcpServer name collides across apps", async () => {
    const folderA = freshFixture("app-a");
    await installApp(folderA);
    // Build a second fixture with a clashing mcpServer name
    const folderB = freshFixture("app-b");
    const manifestPath = join(folderB, "manifest.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    // Mcp name kept identical (`example-echo`) — distinct app id + agents though
    m.agents = [{ name: "app-b-owner", type: "bare" }];
    m.schedules = [];
    writeFileSync(manifestPath, JSON.stringify(m));
    await expect(installApp(folderB)).rejects.toThrow(/already declared/);
  });
});

describe("uninstallApp", () => {
  it("archives owned agents, drops schedules, and renames the folder", async () => {
    const folder = freshFixture();
    await installApp(folder);
    const result = await uninstallApp("example-app");
    expect(result.folderDisposition).toBe("archive");
    expect(result.archivedFolderPath).toBeDefined();
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(result.archivedFolderPath!)).toBe(true);

    // App row gone
    const db = getDb();
    expect(await db.select().from(schema.apps)).toHaveLength(0);
    // Schedules dropped
    expect(await db.select().from(schema.schedules)).toHaveLength(0);
    // Agents kept (preserve-over-delete); status will be archived
    // once lifecycle.archiveAgent runs — our mock no-ops, so we just
    // verify the tombstoned appId is intact.
    expect(await registry.getAppId("example-owner")).toBe("example-app");
  });

  it("folderDisposition=keep leaves the folder in place", async () => {
    const folder = freshFixture();
    await installApp(folder);
    await uninstallApp("example-app", { folderDisposition: "keep" });
    expect(existsSync(folder)).toBe(true);
  });

  it("folderDisposition=delete removes the folder", async () => {
    const folder = freshFixture();
    await installApp(folder);
    await uninstallApp("example-app", { folderDisposition: "delete" });
    expect(existsSync(folder)).toBe(false);
  });

  it("throws on missing app", async () => {
    await expect(uninstallApp("does-not-exist")).rejects.toThrow(/not installed/);
  });
});

describe("reloadApp", () => {
  it("no-ops when manifest unchanged", async () => {
    const folder = freshFixture();
    await installApp(folder);
    const r = await reloadApp("example-app");
    expect(r.changed).toBe(false);
  });

  it("flips status to orphaned when folder disappears", async () => {
    const folder = freshFixture();
    await installApp(folder);
    rmSync(folder, { recursive: true, force: true });
    const r = await reloadApp("example-app");
    expect(r.changed).toBe(true);
    const detail = await inspectApp("example-app");
    expect(detail!.status).toBe("orphaned");
  });

  it("picks up new agents added to the manifest", async () => {
    const folder = freshFixture();
    await installApp(folder);
    const manifestPath = join(folder, "manifest.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    m.agents.push({ name: "example-extra", type: "bare" });
    m.version = "0.2.0";
    writeFileSync(manifestPath, JSON.stringify(m));
    const r = await reloadApp("example-app");
    expect(r.changed).toBe(true);
    expect(await registry.getAgent("example-extra")).not.toBeNull();
    expect(await registry.getAppId("example-extra")).toBe("example-app");
  });

  it("does NOT auto-archive agents removed from the manifest", async () => {
    const folder = freshFixture();
    await installApp(folder);
    const manifestPath = join(folder, "manifest.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    m.agents = m.agents.filter((a: { name: string }) => a.name !== "example-weekly");
    m.schedules = [];
    writeFileSync(manifestPath, JSON.stringify(m));
    await reloadApp("example-app");
    // Weekly agent still present, still owned (preserve-over-delete)
    expect(await registry.getAgent("example-weekly")).not.toBeNull();
  });
});

describe("listApps / inspectApp", () => {
  it("lists installed apps; inspect returns full detail or null", async () => {
    expect(await listApps()).toHaveLength(0);
    const folder = freshFixture();
    await installApp(folder);
    const all = await listApps();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("example-app");

    const detail = await inspectApp("example-app");
    expect(detail).not.toBeNull();
    expect(detail!.manifest.id).toBe("example-app");
    expect(detail!.agents.map((a) => a.name).sort()).toEqual(["example-owner", "example-weekly"]);
    expect(detail!.schedules.map((s) => s.name)).toEqual(["example-weekly-run"]);
    expect(detail!.mcpServers.map((m) => m.name)).toEqual(["example-echo"]);

    expect(await inspectApp("ghost")).toBeNull();
  });
});
