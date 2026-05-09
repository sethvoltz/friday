/**
 * Cluster open/critical proposals by Jaccard overlap of their signal-hash
 * sets. Materializes a markdown file per cluster + stamps `clusterId` on
 * each member proposal.
 *
 * Ported nearly verbatim from old SlackAgents Friday.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { EVOLVE_CLUSTERS_DIR } from "@friday/shared";
import { listProposals, updateProposal } from "./store.js";
import type { Proposal } from "./types.js";

export interface Cluster {
  id: string;
  title: string;
  /** Ordered proposal ids. First is the canonical "anchor". */
  members: string[];
  createdAt: string;
  updatedAt: string;
}

export function ensureClustersDir(): void {
  mkdirSync(EVOLVE_CLUSTERS_DIR, { recursive: true });
}

function filePath(id: string): string {
  return join(EVOLVE_CLUSTERS_DIR, `${id}.md`);
}

function generateId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  const suffix = Date.now().toString(36).slice(-4);
  return `cluster-${slug}-${suffix}`;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseCluster(id: string, raw: string): Cluster {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) throw new Error(`Invalid cluster format: ${id}`);
  const fields: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    fields[m[1]] = parseValue(m[2]);
  }
  return {
    id,
    title: typeof fields.title === "string" ? fields.title : id,
    members: Array.isArray(fields.members) ? (fields.members as string[]) : [],
    createdAt:
      typeof fields.createdAt === "string"
        ? fields.createdAt
        : new Date().toISOString(),
    updatedAt:
      typeof fields.updatedAt === "string"
        ? fields.updatedAt
        : new Date().toISOString(),
  };
}

export function serializeCluster(c: Cluster, body: string): string {
  return [
    "---",
    `title: ${JSON.stringify(c.title)}`,
    `members: ${JSON.stringify(c.members)}`,
    `createdAt: "${c.createdAt}"`,
    `updatedAt: "${c.updatedAt}"`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function parseValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "null" || trimmed === "") return null;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return trimmed;
}

export function listClusters(): Cluster[] {
  ensureClustersDir();
  const files = readdirSync(EVOLVE_CLUSTERS_DIR).filter((f) =>
    f.endsWith(".md"),
  );
  const out: Cluster[] = [];
  for (const file of files) {
    const id = basename(file, ".md");
    try {
      out.push(
        parseCluster(
          id,
          readFileSync(join(EVOLVE_CLUSTERS_DIR, file), "utf-8"),
        ),
      );
    } catch {
      // Skip malformed.
    }
  }
  return out;
}

export function getCluster(id: string): Cluster | null {
  const p = filePath(id);
  if (!existsSync(p)) return null;
  return parseCluster(id, readFileSync(p, "utf-8"));
}

export function saveCluster(c: Cluster, body: string): void {
  ensureClustersDir();
  writeFileSync(filePath(c.id), serializeCluster(c, body));
}

export interface MergeOptions {
  /** Jaccard overlap threshold above which two proposals merge. Default 0.5. */
  threshold?: number;
}

export interface MergeResult {
  clustersCreated: Cluster[];
  clustersUpdated: Cluster[];
  proposalsAttached: number;
}

export function mergeClusters(opts: MergeOptions = {}): MergeResult {
  const threshold = opts.threshold ?? 0.5;
  const result: MergeResult = {
    clustersCreated: [],
    clustersUpdated: [],
    proposalsAttached: 0,
  };

  const proposals = listProposals().filter(
    (p) => p.status === "open" || p.status === "critical",
  );
  if (proposals.length < 2) return result;

  const hashSets = proposals.map((p) => new Set(p.signals.map((s) => s.hash)));

  const parent = proposals.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < proposals.length; i++) {
    for (let j = i + 1; j < proposals.length; j++) {
      if (jaccard(hashSets[i], hashSets[j]) >= threshold) union(i, j);
    }
  }

  const components = new Map<number, number[]>();
  for (let i = 0; i < proposals.length; i++) {
    const root = find(i);
    const arr = components.get(root) ?? [];
    arr.push(i);
    components.set(root, arr);
  }

  const existingClusters = listClusters();
  const byId = new Map(existingClusters.map((c) => [c.id, c]));

  for (const indices of components.values()) {
    if (indices.length < 2) continue;

    const memberProposals = indices.map((i) => proposals[i]);
    const memberIds = memberProposals.map((p) => p.id);
    const existingClusterId =
      memberProposals.find((p) => p.clusterId)?.clusterId ?? null;
    const now = new Date().toISOString();
    const title = clusterTitleFor(memberProposals);
    const body = clusterBody(memberProposals);

    if (existingClusterId && byId.has(existingClusterId)) {
      const cluster = byId.get(existingClusterId)!;
      cluster.members = memberIds;
      cluster.updatedAt = now;
      cluster.title = title;
      saveCluster(cluster, body);
      result.clustersUpdated.push(cluster);
      for (const p of memberProposals) {
        if (p.clusterId !== cluster.id) {
          updateProposal(p.id, { clusterId: cluster.id });
          result.proposalsAttached++;
        }
      }
      continue;
    }

    const cluster: Cluster = {
      id: generateId(title),
      title,
      members: memberIds,
      createdAt: now,
      updatedAt: now,
    };
    saveCluster(cluster, body);
    result.clustersCreated.push(cluster);
    for (const p of memberProposals) {
      updateProposal(p.id, { clusterId: cluster.id });
      result.proposalsAttached++;
    }
  }

  return result;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const v of a) if (b.has(v)) intersection++;
  const unionSize = a.size + b.size - intersection;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

function clusterTitleFor(members: Proposal[]): string {
  const ranked = [...members].sort((a, b) => b.score - a.score);
  return ranked[0].title;
}

function clusterBody(members: Proposal[]): string {
  const lines = [
    `Cluster of ${members.length} related proposals.`,
    "",
    "**Members:**",
    ...members
      .sort((a, b) => b.score - a.score)
      .map((p) => `- \`${p.id}\` (${p.score}) — ${p.title}`),
  ];
  return lines.join("\n");
}

export { EVOLVE_CLUSTERS_DIR as CLUSTERS_DIR };
