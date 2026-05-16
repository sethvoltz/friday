/**
 * App manifest: the contract on disk at `~/.friday/apps/<id>/manifest.json`.
 *
 * Forward-fail: `manifestVersion` must be the literal `1`. Unknown versions
 * are rejected at install rather than silently coerced — fields may carry
 * new semantics we don't yet know about.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { z } from "zod";

export const APP_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

export const manifestAgentSchema = z.object({
  name: z.string().regex(AGENT_NAME_RE),
  type: z.enum(["bare", "scheduled"]),
  promptOverlay: z.string().optional(),
});

export const manifestScheduleSchema = z.object({
  name: z.string().min(1),
  cron: z.string().min(1),
  agent: z.string().regex(AGENT_NAME_RE),
  taskPrompt: z.string().min(1),
});

export const manifestMcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.literal("node"),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
});

export const manifestSchemaV1 = z.object({
  manifestVersion: z.literal(1),
  id: z.string().regex(APP_ID_RE),
  name: z.string().min(1).max(64),
  version: z.string().regex(SEMVER_RE),
  summary: z.string().max(280).optional(),
  author: z.string().max(64).optional(),

  agents: z.array(manifestAgentSchema).min(1),
  schedules: z.array(manifestScheduleSchema).default([]),
  mcpServers: z.array(manifestMcpServerSchema).default([]),
});

export type Manifest = z.infer<typeof manifestSchemaV1>;
export type ManifestAgent = z.infer<typeof manifestAgentSchema>;
export type ManifestSchedule = z.infer<typeof manifestScheduleSchema>;
export type ManifestMcpServer = z.infer<typeof manifestMcpServerSchema>;

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

/**
 * Parse + validate a raw manifest object. Runs zod first, then the
 * post-zod checks (agent/schedule cross-refs, path containment).
 *
 * `folderPath` is required so the path-containment checks can resolve
 * `promptOverlay` and each `mcpServers[].args[]` against the app folder.
 */
export function parseManifest(raw: unknown, folderPath: string): Manifest {
  // Pre-check `manifestVersion` so the error is friendlier than a generic
  // zod "Invalid literal" stack — manifest authors are humans.
  if (
    raw &&
    typeof raw === "object" &&
    "manifestVersion" in raw &&
    (raw as { manifestVersion: unknown }).manifestVersion !== 1
  ) {
    const got = (raw as { manifestVersion: unknown }).manifestVersion;
    throw new ManifestValidationError(
      `unsupported manifestVersion: ${JSON.stringify(got)} (this Friday only understands manifestVersion: 1)`,
    );
  }

  const parsed = manifestSchemaV1.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.join(".");
    throw new ManifestValidationError(
      `manifest invalid${path ? ` at \`${path}\`` : ""}: ${issue.message}`,
    );
  }
  const m = parsed.data;

  // Cross-ref: every schedule.agent must resolve to a scheduled agent
  const agentByName = new Map(m.agents.map((a) => [a.name, a]));
  for (const s of m.schedules) {
    const a = agentByName.get(s.agent);
    if (!a) {
      throw new ManifestValidationError(
        `schedule "${s.name}" references unknown agent "${s.agent}"`,
      );
    }
    if (a.type !== "scheduled") {
      throw new ManifestValidationError(
        `schedule "${s.name}" references agent "${s.agent}" which is type "${a.type}"; schedules require a "scheduled"-type agent`,
      );
    }
  }

  // Agent name uniqueness within the manifest
  const seenAgents = new Set<string>();
  for (const a of m.agents) {
    if (seenAgents.has(a.name)) {
      throw new ManifestValidationError(
        `duplicate agent name in manifest: "${a.name}"`,
      );
    }
    seenAgents.add(a.name);
  }

  // Schedule name uniqueness
  const seenSchedules = new Set<string>();
  for (const s of m.schedules) {
    if (seenSchedules.has(s.name)) {
      throw new ManifestValidationError(
        `duplicate schedule name in manifest: "${s.name}"`,
      );
    }
    seenSchedules.add(s.name);
  }

  // MCP server name uniqueness + no `friday-` prefix
  const seenMcp = new Set<string>();
  for (const srv of m.mcpServers) {
    if (seenMcp.has(srv.name)) {
      throw new ManifestValidationError(
        `duplicate mcpServer name in manifest: "${srv.name}"`,
      );
    }
    seenMcp.add(srv.name);
    if (srv.name.startsWith("friday-")) {
      throw new ManifestValidationError(
        `mcpServer name "${srv.name}" reserved (the \`friday-\` prefix is for built-in servers)`,
      );
    }
  }

  // Path containment: every promptOverlay and every mcpServers[].args[]
  // entry must resolve inside the app folder.
  for (const a of m.agents) {
    if (a.promptOverlay !== undefined) {
      assertPathInside(folderPath, a.promptOverlay, `agents.${a.name}.promptOverlay`);
    }
  }
  for (const srv of m.mcpServers) {
    for (let i = 0; i < srv.args.length; i++) {
      const arg = srv.args[i];
      // Only validate args that look like paths (heuristic: contains `/` or
      // ends in a script extension). Bare flags like `--foo` are passed
      // through untouched.
      if (isLikelyPath(arg)) {
        assertPathInside(folderPath, arg, `mcpServers.${srv.name}.args[${i}]`);
      }
    }
  }

  return m;
}

/**
 * Read and parse `<folderPath>/manifest.json`. Throws if the file is
 * missing or unreadable JSON; otherwise delegates to `parseManifest`.
 */
export function loadManifest(folderPath: string): Manifest {
  const manifestPath = join(folderPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new ManifestValidationError(
      `manifest.json not found at ${manifestPath}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new ManifestValidationError(
      `manifest.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseManifest(raw, folderPath);
}

function isLikelyPath(arg: string): boolean {
  if (arg.startsWith("-")) return false;
  return arg.includes("/") || /\.(m?js|cjs|ts)$/i.test(arg);
}

function assertPathInside(
  folderPath: string,
  relPath: string,
  fieldLabel: string,
): void {
  if (isAbsolute(relPath)) {
    throw new ManifestValidationError(
      `${fieldLabel}: absolute paths are not allowed ("${relPath}")`,
    );
  }
  const resolved = normalize(join(folderPath, relPath));
  const rel = relative(folderPath, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ManifestValidationError(
      `${fieldLabel}: path escapes app folder ("${relPath}")`,
    );
  }
}
