import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join, basename } from "node:path";
import { FRIDAY_DIR } from "@friday/shared";

/** Root directory for memory storage */
export const MEMORY_DIR = join(FRIDAY_DIR, "memory");
const ENTRIES_DIR = join(MEMORY_DIR, "entries");

export interface MemoryEntry {
  /** Unique ID derived from filename (without extension) */
  id: string;
  /** Short title */
  title: string;
  /** Memory content (the body text) */
  content: string;
  /** Tags for categorization and search */
  tags: string[];
  /** Who created this memory */
  createdBy: string;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
  /** Number of times this memory has been recalled */
  recallCount: number;
  /** ISO timestamp of last recall */
  lastRecalledAt: string | null;
}

/**
 * Ensure the memory directories exist.
 */
export function ensureMemoryDirs(): void {
  mkdirSync(ENTRIES_DIR, { recursive: true });
}

/**
 * Generate a unique ID for a memory entry.
 * Uses a slugified version of the title + timestamp suffix for uniqueness.
 */
export function generateId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const suffix = Date.now().toString(36).slice(-4);
  return `${slug}-${suffix}`;
}

/**
 * Parse a memory markdown file into a MemoryEntry.
 * Format:
 * ---
 * title: ...
 * tags: [...]
 * createdBy: ...
 * createdAt: ...
 * updatedAt: ...
 * recallCount: N
 * lastRecalledAt: ...
 * ---
 * Body content here
 */
export function parseEntry(id: string, raw: string): MemoryEntry {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error(`Invalid memory entry format: ${id}`);
  }

  const frontmatter = fmMatch[1];
  const content = fmMatch[2].trim();

  const fields = parseFrontmatter(frontmatter);

  return {
    id,
    title: fields.title ?? id,
    content,
    tags: fields.tags ?? [],
    createdBy: fields.createdBy ?? "unknown",
    createdAt: fields.createdAt ?? new Date().toISOString(),
    updatedAt: fields.updatedAt ?? new Date().toISOString(),
    recallCount: fields.recallCount ?? 0,
    lastRecalledAt: fields.lastRecalledAt ?? null,
  };
}

/**
 * Serialize a MemoryEntry to markdown with YAML frontmatter.
 */
export function serializeEntry(entry: MemoryEntry): string {
  const tagsLine =
    entry.tags.length > 0 ? `[${entry.tags.map((t) => `"${t}"`).join(", ")}]` : "[]";

  const lines = [
    "---",
    `title: ${JSON.stringify(entry.title)}`,
    `tags: ${tagsLine}`,
    `createdBy: "${entry.createdBy}"`,
    `createdAt: "${entry.createdAt}"`,
    `updatedAt: "${entry.updatedAt}"`,
    `recallCount: ${entry.recallCount}`,
    `lastRecalledAt: ${entry.lastRecalledAt ? `"${entry.lastRecalledAt}"` : "null"}`,
    "---",
    "",
    entry.content,
    "",
  ];

  return lines.join("\n");
}

/**
 * Save a new memory entry. Returns the entry with generated ID.
 */
export function saveEntry(opts: {
  title: string;
  content: string;
  tags?: string[];
  createdBy: string;
}): MemoryEntry {
  ensureMemoryDirs();

  const id = generateId(opts.title);
  const now = new Date().toISOString();

  const entry: MemoryEntry = {
    id,
    title: opts.title,
    content: opts.content,
    tags: opts.tags ?? [],
    createdBy: opts.createdBy,
    createdAt: now,
    updatedAt: now,
    recallCount: 0,
    lastRecalledAt: null,
  };

  writeFileSync(join(ENTRIES_DIR, `${id}.md`), serializeEntry(entry));
  return entry;
}

/**
 * Get a memory entry by ID.
 */
export function getEntry(id: string): MemoryEntry | null {
  const filePath = join(ENTRIES_DIR, `${id}.md`);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  return parseEntry(id, raw);
}

/**
 * Update a memory entry's recall tracking.
 */
export function touchRecall(id: string): MemoryEntry | null {
  const entry = getEntry(id);
  if (!entry) return null;

  entry.recallCount++;
  entry.lastRecalledAt = new Date().toISOString();

  writeFileSync(join(ENTRIES_DIR, `${id}.md`), serializeEntry(entry));
  return entry;
}

/**
 * Update a memory entry's content and/or metadata.
 */
export function updateEntry(
  id: string,
  updates: Partial<Pick<MemoryEntry, "title" | "content" | "tags">>
): MemoryEntry | null {
  const entry = getEntry(id);
  if (!entry) return null;

  if (updates.title !== undefined) entry.title = updates.title;
  if (updates.content !== undefined) entry.content = updates.content;
  if (updates.tags !== undefined) entry.tags = updates.tags;
  entry.updatedAt = new Date().toISOString();

  writeFileSync(join(ENTRIES_DIR, `${id}.md`), serializeEntry(entry));
  return entry;
}

/**
 * Delete a memory entry. Returns true if it existed.
 */
export function forgetEntry(id: string): boolean {
  const filePath = join(ENTRIES_DIR, `${id}.md`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

/**
 * List all memory entries.
 */
export function listEntries(): MemoryEntry[] {
  ensureMemoryDirs();

  const files = readdirSync(ENTRIES_DIR).filter((f) => f.endsWith(".md"));
  const entries: MemoryEntry[] = [];

  for (const file of files) {
    const id = basename(file, ".md");
    try {
      const raw = readFileSync(join(ENTRIES_DIR, file), "utf-8");
      entries.push(parseEntry(id, raw));
    } catch {
      // Skip malformed entries
    }
  }

  return entries;
}

// ── Frontmatter parser (minimal YAML subset) ────────────────────

function parseFrontmatter(text: string): Record<string, any> {
  const result: Record<string, any> = {};

  for (const line of text.split("\n")) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    result[key] = parseValue(rawValue);
  }

  return result;
}

function parseValue(raw: string): any {
  const trimmed = raw.trim();

  // null
  if (trimmed === "null" || trimmed === "") return null;

  // Number
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);

  // Array: [...]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => {
      const v = s.trim();
      // Strip quotes
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        return v.slice(1, -1);
      }
      return v;
    });
  }

  // Quoted string — handle escaped quotes
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }

  // Boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  return trimmed;
}
