import { eq } from "drizzle-orm";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  MEMORY_ENTRIES_DIR,
  ensureDirs,
  getDb,
  schema,
} from "@friday/shared";

export interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  recallCount: number;
  lastRecalledAt: string | null;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export function ensureMemoryDirs(): void {
  ensureDirs();
  if (!existsSync(MEMORY_ENTRIES_DIR)) {
    mkdirSync(MEMORY_ENTRIES_DIR, { recursive: true });
  }
}

function entryPath(id: string): string {
  return join(MEMORY_ENTRIES_DIR, `${id}.md`);
}

export function parseEntry(id: string, raw: string): MemoryEntry {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) {
    return {
      id,
      title: id,
      content: raw,
      tags: [],
      createdBy: "unknown",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      recallCount: 0,
      lastRecalledAt: null,
    };
  }
  const fm = parseYamlish(m[1]);
  return {
    id,
    title: typeof fm.title === "string" ? fm.title : id,
    content: m[2],
    tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
    createdBy: typeof fm.createdBy === "string" ? fm.createdBy : "unknown",
    createdAt: typeof fm.createdAt === "string" ? fm.createdAt : new Date().toISOString(),
    updatedAt: typeof fm.updatedAt === "string" ? fm.updatedAt : new Date().toISOString(),
    recallCount: 0,
    lastRecalledAt: null,
  };
}

export function serializeEntry(entry: MemoryEntry): string {
  const fm = [
    `title: ${entry.title}`,
    `tags: ${JSON.stringify(entry.tags)}`,
    `createdBy: ${entry.createdBy}`,
    `createdAt: ${entry.createdAt}`,
    `updatedAt: ${entry.updatedAt}`,
  ].join("\n");
  return `---\n${fm}\n---\n${entry.content}`;
}

export function saveEntry(entry: MemoryEntry): void {
  ensureMemoryDirs();
  const path = entryPath(entry.id);
  writeFileSync(path, serializeEntry(entry));
  const db = getDb();
  const fileMtime = statSync(path).mtimeMs;
  const existing = db
    .select()
    .from(schema.memoryEntries)
    .where(eq(schema.memoryEntries.id, entry.id))
    .get();
  if (existing) {
    db.update(schema.memoryEntries)
      .set({
        title: entry.title,
        content: entry.content,
        tagsJson: JSON.stringify(entry.tags),
        createdBy: entry.createdBy,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        fileMtime,
      })
      .where(eq(schema.memoryEntries.id, entry.id))
      .run();
  } else {
    db.insert(schema.memoryEntries)
      .values({
        id: entry.id,
        title: entry.title,
        content: entry.content,
        tagsJson: JSON.stringify(entry.tags),
        createdBy: entry.createdBy,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        fileMtime,
        recallCount: 0,
        lastRecalledAt: null,
      })
      .run();
  }
}

export function getEntry(id: string): MemoryEntry | null {
  const db = getDb();
  const row = db
    .select()
    .from(schema.memoryEntries)
    .where(eq(schema.memoryEntries.id, id))
    .get();
  if (!row) {
    const path = entryPath(id);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    return parseEntry(id, raw);
  }
  return rowToEntry(row);
}

export function updateEntry(id: string, patch: Partial<MemoryEntry>): void {
  const cur = getEntry(id);
  if (!cur) return;
  const next: MemoryEntry = {
    ...cur,
    ...patch,
    id,
    updatedAt: new Date().toISOString(),
  };
  saveEntry(next);
}

export function forgetEntry(id: string): void {
  const path = entryPath(id);
  if (existsSync(path)) rmSync(path);
  const db = getDb();
  db.delete(schema.memoryEntries)
    .where(eq(schema.memoryEntries.id, id))
    .run();
}

export function listEntries(): MemoryEntry[] {
  const db = getDb();
  const rows = db.select().from(schema.memoryEntries).all();
  return rows.map(rowToEntry);
}

export function touchRecall(id: string): void {
  const db = getDb();
  const row = db
    .select()
    .from(schema.memoryEntries)
    .where(eq(schema.memoryEntries.id, id))
    .get();
  if (!row) return;
  db.update(schema.memoryEntries)
    .set({
      recallCount: row.recallCount + 1,
      lastRecalledAt: new Date().toISOString(),
    })
    .where(eq(schema.memoryEntries.id, id))
    .run();
}

function rowToEntry(r: typeof schema.memoryEntries.$inferSelect): MemoryEntry {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    tags: JSON.parse(r.tagsJson) as string[],
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    recallCount: r.recallCount,
    lastRecalledAt: r.lastRecalledAt,
  };
}

/**
 * Tiny "yaml-ish" parser sufficient for the keys we actually use:
 * title, tags, createdBy, createdAt, updatedAt. Tags may be a JSON array.
 */
function parseYamlish(s: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of s.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (v.startsWith("[")) {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}
