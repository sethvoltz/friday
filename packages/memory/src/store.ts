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
  /** ISO-8601 string. */
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
    createdAt:
      typeof fm.createdAt === "string"
        ? fm.createdAt
        : new Date().toISOString(),
    updatedAt:
      typeof fm.updatedAt === "string"
        ? fm.updatedAt
        : new Date().toISOString(),
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

export async function saveEntry(entry: MemoryEntry): Promise<void> {
  ensureMemoryDirs();
  const path = entryPath(entry.id);
  writeFileSync(path, serializeEntry(entry));
  const db = getDb();
  const fileMtime = new Date(statSync(path).mtimeMs);
  const existingRows = await db
    .select()
    .from(schema.memoryEntries)
    .where(eq(schema.memoryEntries.id, entry.id))
    .limit(1);
  if (existingRows[0]) {
    await db
      .update(schema.memoryEntries)
      .set({
        title: entry.title,
        content: entry.content,
        tagsJson: entry.tags,
        createdBy: entry.createdBy,
        createdAt: new Date(entry.createdAt),
        updatedAt: new Date(entry.updatedAt),
        fileMtime,
      })
      .where(eq(schema.memoryEntries.id, entry.id));
  } else {
    await db.insert(schema.memoryEntries).values({
      id: entry.id,
      title: entry.title,
      content: entry.content,
      tagsJson: entry.tags,
      createdBy: entry.createdBy,
      createdAt: new Date(entry.createdAt),
      updatedAt: new Date(entry.updatedAt),
      fileMtime,
      recallCount: 0,
      lastRecalledAt: null,
    });
  }
}

export async function getEntry(id: string): Promise<MemoryEntry | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.memoryEntries)
    .where(eq(schema.memoryEntries.id, id))
    .limit(1);
  if (!rows[0]) {
    const path = entryPath(id);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    return parseEntry(id, raw);
  }
  return rowToEntry(rows[0]);
}

export async function updateEntry(
  id: string,
  patch: Partial<MemoryEntry>,
): Promise<void> {
  const cur = await getEntry(id);
  if (!cur) return;
  const next: MemoryEntry = {
    ...cur,
    ...patch,
    id,
    updatedAt: new Date().toISOString(),
  };
  await saveEntry(next);
}

export async function forgetEntry(id: string): Promise<void> {
  const path = entryPath(id);
  if (existsSync(path)) rmSync(path);
  const db = getDb();
  await db
    .delete(schema.memoryEntries)
    .where(eq(schema.memoryEntries.id, id));
}

export async function listEntries(): Promise<MemoryEntry[]> {
  const db = getDb();
  const rows = await db.select().from(schema.memoryEntries);
  return rows.map(rowToEntry);
}

export async function touchRecall(id: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.memoryEntries)
    .where(eq(schema.memoryEntries.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return;
  await db
    .update(schema.memoryEntries)
    .set({
      recallCount: row.recallCount + 1,
      lastRecalledAt: new Date(),
    })
    .where(eq(schema.memoryEntries.id, id));
}

function rowToEntry(r: typeof schema.memoryEntries.$inferSelect): MemoryEntry {
  // tags_json is jsonb in Postgres; Drizzle returns it as a parsed value.
  // Defend against historical rows that may have been stored as strings.
  const tagsRaw = r.tagsJson;
  const tags = Array.isArray(tagsRaw)
    ? (tagsRaw as string[])
    : typeof tagsRaw === "string"
      ? (JSON.parse(tagsRaw) as string[])
      : [];
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    tags,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    recallCount: r.recallCount,
    lastRecalledAt: r.lastRecalledAt
      ? r.lastRecalledAt.toISOString()
      : null,
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
