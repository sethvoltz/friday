import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManifestValidationError,
  loadManifest,
  parseManifest,
} from "./manifest.js";

function mkFolder(): string {
  return mkdtempSync(join(tmpdir(), "friday-app-test-"));
}

const minimal = (id = "myapp") => ({
  manifestVersion: 1,
  id,
  name: "My App",
  version: "1.2.3",
  agents: [{ name: "owner", type: "bare" as const }],
});

describe("parseManifest", () => {
  it("accepts a minimal manifest", () => {
    const folder = mkFolder();
    const m = parseManifest(minimal(), folder);
    expect(m.id).toBe("myapp");
    expect(m.version).toBe("1.2.3");
    expect(m.agents).toHaveLength(1);
    expect(m.schedules).toEqual([]);
    expect(m.mcpServers).toEqual([]);
  });

  it("rejects unknown manifestVersion with a clear message", () => {
    const folder = mkFolder();
    expect(() => parseManifest({ ...minimal(), manifestVersion: 2 }, folder))
      .toThrowError(/unsupported manifestVersion: 2/);
  });

  it("rejects bad app id", () => {
    const folder = mkFolder();
    expect(() => parseManifest(minimal("BadID"), folder)).toThrowError(
      ManifestValidationError,
    );
  });

  it("rejects non-semver version", () => {
    const folder = mkFolder();
    expect(() =>
      parseManifest({ ...minimal(), version: "v1" }, folder),
    ).toThrowError(ManifestValidationError);
  });

  it("rejects empty agents array", () => {
    const folder = mkFolder();
    expect(() =>
      parseManifest({ ...minimal(), agents: [] }, folder),
    ).toThrowError(ManifestValidationError);
  });

  it("rejects schedule referencing missing agent", () => {
    const folder = mkFolder();
    expect(() =>
      parseManifest(
        {
          ...minimal(),
          schedules: [
            { name: "s1", cron: "0 4 * * *", agent: "ghost", taskPrompt: "go" },
          ],
        },
        folder,
      ),
    ).toThrowError(/unknown agent "ghost"/);
  });

  it("rejects schedule pointing at a bare agent", () => {
    const folder = mkFolder();
    expect(() =>
      parseManifest(
        {
          ...minimal(),
          schedules: [
            {
              name: "s1",
              cron: "0 4 * * *",
              agent: "owner",
              taskPrompt: "go",
            },
          ],
        },
        folder,
      ),
    ).toThrowError(/type "bare"/);
  });

  it("accepts scheduled agent + matching schedule", () => {
    const folder = mkFolder();
    const m = parseManifest(
      {
        ...minimal(),
        agents: [
          { name: "owner", type: "bare" as const },
          { name: "weekly", type: "scheduled" as const },
        ],
        schedules: [
          { name: "weekly-run", cron: "0 4 * * *", agent: "weekly", taskPrompt: "go" },
        ],
      },
      folder,
    );
    expect(m.schedules).toHaveLength(1);
  });

  it("rejects duplicate agent names", () => {
    const folder = mkFolder();
    expect(() =>
      parseManifest(
        {
          ...minimal(),
          agents: [
            { name: "owner", type: "bare" as const },
            { name: "owner", type: "bare" as const },
          ],
        },
        folder,
      ),
    ).toThrowError(/duplicate agent name/);
  });

  it("rejects mcpServer with command other than node", () => {
    const folder = mkFolder();
    expect(() =>
      parseManifest(
        {
          ...minimal(),
          mcpServers: [
            { name: "x", command: "python", args: ["mcp/x.py"] },
          ],
        },
        folder,
      ),
    ).toThrowError(ManifestValidationError);
  });

  it("rejects mcpServer name with friday- prefix", () => {
    const folder = mkFolder();
    expect(() =>
      parseManifest(
        {
          ...minimal(),
          mcpServers: [
            { name: "friday-evil", command: "node", args: ["mcp/x.js"] },
          ],
        },
        folder,
      ),
    ).toThrowError(/reserved/);
  });

  it("rejects mcpServer args with absolute path", () => {
    const folder = mkFolder();
    expect(() =>
      parseManifest(
        {
          ...minimal(),
          mcpServers: [
            { name: "x", command: "node", args: ["/etc/passwd"] },
          ],
        },
        folder,
      ),
    ).toThrowError(/absolute paths/);
  });

  it("rejects mcpServer args escaping app folder", () => {
    const folder = mkFolder();
    expect(() =>
      parseManifest(
        {
          ...minimal(),
          mcpServers: [
            { name: "x", command: "node", args: ["../escape.js"] },
          ],
        },
        folder,
      ),
    ).toThrowError(/escapes app folder/);
  });

  it("rejects promptOverlay escaping app folder", () => {
    const folder = mkFolder();
    expect(() =>
      parseManifest(
        {
          ...minimal(),
          agents: [
            {
              name: "owner",
              type: "bare" as const,
              promptOverlay: "../../etc/shadow",
            },
          ],
        },
        folder,
      ),
    ).toThrowError(/escapes app folder/);
  });

  it("allows bare flags in mcpServer args", () => {
    const folder = mkFolder();
    expect(() =>
      parseManifest(
        {
          ...minimal(),
          mcpServers: [
            { name: "x", command: "node", args: ["mcp/x.js", "--flag"] },
          ],
        },
        folder,
      ),
    ).not.toThrow();
  });
});

describe("loadManifest", () => {
  it("loads and parses a real on-disk manifest", () => {
    const folder = mkFolder();
    writeFileSync(
      join(folder, "manifest.json"),
      JSON.stringify(minimal("disk-app"), null, 2),
    );
    const m = loadManifest(folder);
    expect(m.id).toBe("disk-app");
  });

  it("throws when manifest.json is missing", () => {
    const folder = mkFolder();
    expect(() => loadManifest(folder)).toThrowError(/not found/);
  });

  it("throws on invalid JSON", () => {
    const folder = mkFolder();
    writeFileSync(join(folder, "manifest.json"), "{not json");
    expect(() => loadManifest(folder)).toThrowError(/not valid JSON/);
  });

  it("validates promptOverlay points inside the folder when set", () => {
    const folder = mkFolder();
    mkdirSync(join(folder, "sub"));
    writeFileSync(
      join(folder, "manifest.json"),
      JSON.stringify({
        ...minimal(),
        agents: [{ name: "owner", type: "bare", promptOverlay: "sub/p.md" }],
      }),
    );
    const m = loadManifest(folder);
    expect(m.agents[0].promptOverlay).toBe("sub/p.md");
  });
});
