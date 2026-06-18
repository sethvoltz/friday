import { and, eq, sql } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDING_DIM, MEMORY_ENTRIES_DIR, ensureDirs, getDb, schema } from "@friday/shared";
import { embedText } from "./embed.js";

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

export async function saveEntry(entry: MemoryEntry): Promise<void> {
  ensureMemoryDirs();
  const path = entryPath(entry.id);
  writeFileSync(path, serializeEntry(entry));
  const db = getDb();
  const fileMtime = new Date(statSync(path).mtimeMs);
  const existingRows = await db
    .select({ id: schema.memoryEntries.id })
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

  // Best-effort semantic embedding. Lives OUTSIDE the durability-critical
  // path: the .md file and the canonical row are already persisted above, so a
  // missing/crashed embedder leaves `embedding` NULL (recall degrades to
  // FTS-only) but never loses the entry. FAIL-OPEN — never throws out of
  // saveEntry. The raw `::vector` cast is used rather than Drizzle's
  // `.set({ embedding })` because the customType passes a bare string param
  // that Postgres won't implicitly coerce to `vector` in an UPDATE binding.
  try {
    const vec = await embedText(`${entry.title}\n${entry.content}`);
    if (vec && vec.length === EMBEDDING_DIM) {
      const literal = `[${vec.join(",")}]`;
      await db.execute(
        sql`UPDATE memory_entries SET embedding = ${literal}::vector WHERE id = ${entry.id}`,
      );
    }
  } catch {
    // fail-open: embedding stays NULL; file + row already persisted
  }
}

export async function getEntry(id: string): Promise<MemoryEntry | null> {
  const db = getDb();
  const rows = await db
    .select(ENTRY_COLUMNS)
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

export async function updateEntry(id: string, patch: Partial<MemoryEntry>): Promise<void> {
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
  await db.delete(schema.memoryEntries).where(eq(schema.memoryEntries.id, id));
}

export async function listEntries(): Promise<MemoryEntry[]> {
  const db = getDb();
  const rows = await db.select(ENTRY_COLUMNS).from(schema.memoryEntries);
  return rows.map(rowToEntry);
}

/**
 * Return memory entries that should be deterministically included in an
 * agent's system prompt — `tag` membership in `tags_json` AND ownership by
 * `agentName` AND `status === 'ready'`. Distinct from FTS recall: this
 * fires unconditionally at prompt-assembly time, so the agent sees the
 * pin every turn regardless of user-message content.
 *
 * Order is stable by `id` so the rendered prompt is byte-identical across
 * boots — important for SDK prompt caching (FRI-61).
 */
export async function listPinnedForAgent(
  agentName: string,
  tag: string = "pinned",
): Promise<MemoryEntry[]> {
  const db = getDb();
  const rows = await db
    .select(ENTRY_COLUMNS)
    .from(schema.memoryEntries)
    .where(
      and(
        eq(schema.memoryEntries.createdBy, agentName),
        // jsonb `?` operator: "does the top-level JSON array/object contain
        // the given key/element?" For our tags-as-array shape this is an
        // exact-element membership check.
        sql`${schema.memoryEntries.tagsJson} ? ${tag}`,
        eq(schema.memoryEntries.status, "ready"),
      ),
    );
  return rows.map(rowToEntry).sort((a, b) => a.id.localeCompare(b.id));
}

export async function touchRecall(id: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ recallCount: schema.memoryEntries.recallCount })
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

// Column projection that OMITS the heavy `embedding` vector. rowToEntry never
// reads it, and pulling + JSON-parsing a 384-float literal (~3-4KB) on every
// read — listEntries() fires once per passive-recall turn — is pure waste. The
// vector is consumed ONLY by the raw `<=>` SQL in search.ts / backfill.ts, which
// select it explicitly. (FRI-24 perf: adding the column to the table def made
// the bare `.select()` star-fetch it.)
const ENTRY_COLUMNS = {
  id: schema.memoryEntries.id,
  title: schema.memoryEntries.title,
  content: schema.memoryEntries.content,
  tagsJson: schema.memoryEntries.tagsJson,
  createdBy: schema.memoryEntries.createdBy,
  createdAt: schema.memoryEntries.createdAt,
  updatedAt: schema.memoryEntries.updatedAt,
  fileMtime: schema.memoryEntries.fileMtime,
  recallCount: schema.memoryEntries.recallCount,
  lastRecalledAt: schema.memoryEntries.lastRecalledAt,
  status: schema.memoryEntries.status,
} as const;

type MemoryRow = Pick<
  typeof schema.memoryEntries.$inferSelect,
  | "id"
  | "title"
  | "content"
  | "tagsJson"
  | "createdBy"
  | "createdAt"
  | "updatedAt"
  | "recallCount"
  | "lastRecalledAt"
>;

function rowToEntry(r: MemoryRow): MemoryEntry {
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
    lastRecalledAt: r.lastRecalledAt ? r.lastRecalledAt.toISOString() : null,
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
