import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { UPLOADS_DIR } from "../config.js";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";

export interface Attachment {
  sha256: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  uploadedAt: number;
  firstTurnId: number | null;
  /** Absolute path to the bytes on disk. */
  path: string;
}

export interface UploadInput {
  bytes: Buffer;
  filename: string;
  mime: string;
  firstTurnId?: number;
}

/** Pixel-dimension cap on the longest edge when downscaling oversized images. */
const IMAGE_MAX_DIMENSION = 2048;

/* ---------------- Image-pipeline safety bounds (FIX_FORWARD 5.4) ---------------- */
/** Hard upper bound on total decoded pixels. sharp's libvips internally
 *  enforces this — a malicious image that decompresses to billions of
 *  pixels would otherwise pin a worker for ages and consume gigs of RAM. */
const SHARP_LIMIT_INPUT_PIXELS = 100_000_000;
/** Pre-pipeline metadata sanity bounds. */
const META_MAX_DIMENSION = 32_768;
/** Conversion-pipeline wall-clock budget. */
const CONVERSION_TIMEOUT_MS = 10_000;

/**
 * Idempotent upload. DB row is the dedup primary; path existence is a
 * resilience check (we re-write from incoming bytes if the file went missing).
 *
 * HEIC / HEIF inputs are converted to PNG (with a dimension cap) before
 * hashing — Claude's vision blocks reject HEIC, and dedup must operate on
 * the post-conversion bytes so the same photo uploaded twice in different
 * source formats lands on one row.
 */
export async function uploadAttachment(
  input: UploadInput,
): Promise<Attachment> {
  let bytes = input.bytes;
  let filename = input.filename;
  let mime = input.mime;

  if (isHeic(input.bytes, input.mime)) {
    bytes = await convertHeicToPng(input.bytes);
    mime = "image/png";
    filename = swapExt(input.filename, ".png");
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ext = sanitizeExt(filename);
  const path = pathFor(sha256, ext);

  const db = getDb();
  const existing = db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.sha256, sha256))
    .get();

  if (!existsSync(path)) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, bytes);
  }

  if (existing) {
    return rowToAttachment(existing, path);
  }

  const inserted = db
    .insert(schema.attachments)
    .values({
      sha256,
      filename,
      mime,
      sizeBytes: bytes.length,
      uploadedAt: Date.now(),
      firstTurnId: input.firstTurnId ?? null,
    })
    .returning()
    .get();
  return rowToAttachment(inserted, path);
}

function isHeic(buf: Buffer, mime: string): boolean {
  const m = mime.toLowerCase();
  if (m === "image/heic" || m === "image/heif") return true;
  // ISO Base Media File Format `ftyp` brand check at offset 4.
  if (buf.length < 12) return false;
  if (buf.slice(4, 8).toString("ascii") !== "ftyp") return false;
  const brand = buf.slice(8, 12).toString("ascii");
  return (
    brand === "heic" ||
    brand === "heix" ||
    brand === "heim" ||
    brand === "heis" ||
    brand === "hevc" ||
    brand === "hevx" ||
    brand === "mif1" ||
    brand === "msf1"
  );
}

function swapExt(filename: string, newExt: string): string {
  const ext = extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  return `${base}${newExt}`;
}

export function getAttachment(sha256: string): Attachment | null {
  const db = getDb();
  const row = db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.sha256, sha256))
    .get();
  if (!row) return null;
  return rowToAttachment(row, pathFor(sha256, sanitizeExt(row.filename)));
}

export function readAttachmentBytes(sha256: string): Buffer | null {
  const att = getAttachment(sha256);
  if (!att) return null;
  if (!existsSync(att.path)) return null;
  return readFileSync(att.path);
}

function pathFor(sha256: string, ext: string): string {
  // Content-addressed: bucket by the first two hex chars of the sha so paths
  // are stable for dedup regardless of when the file was uploaded.
  const bucket = sha256.slice(0, 2);
  return join(UPLOADS_DIR, bucket, `${sha256}${ext}`);
}

function sanitizeExt(filename: string): string {
  const ext = extname(filename).toLowerCase();
  // Limit to a small allowlist of common extensions for path safety.
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
  return "";
}

function rowToAttachment(
  r: typeof schema.attachments.$inferSelect,
  path: string,
): Attachment {
  return {
    sha256: r.sha256,
    filename: r.filename,
    mime: r.mime,
    sizeBytes: r.sizeBytes,
    uploadedAt: r.uploadedAt,
    firstTurnId: r.firstTurnId,
    path,
  };
}

/**
 * Convert a HEIC/HEIF buffer to PNG with FIX_FORWARD 5.4 safety bounds:
 *   - `limitInputPixels: 100M` rejects pathological decompression bombs.
 *   - `failOn: 'warning'` aborts on libvips warnings (truncated headers,
 *     suspicious metadata) instead of silently producing garbage.
 *   - Pre-pipeline `metadata()` validates that width/height are present
 *     and within sane bounds — guards against zero / negative / overflow
 *     dimensions that the decoder might accept but a downstream consumer
 *     would crash on.
 *   - The whole pipeline races a 10s timeout. A truly slow decode would
 *     otherwise tie up the daemon's upload handler indefinitely.
 */
async function convertHeicToPng(input: Buffer): Promise<Buffer> {
  const meta = await sharp(input, {
    limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
    failOn: "warning",
  }).metadata();
  if (
    !meta.width ||
    !meta.height ||
    meta.width <= 0 ||
    meta.height <= 0 ||
    meta.width > META_MAX_DIMENSION ||
    meta.height > META_MAX_DIMENSION
  ) {
    throw new Error(
      `image dimensions out of bounds: ${meta.width ?? "?"}×${meta.height ?? "?"}`,
    );
  }

  const pipeline = sharp(input, {
    limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
    failOn: "warning",
  })
    .resize({
      width: IMAGE_MAX_DIMENSION,
      height: IMAGE_MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toFormat("png")
    .toBuffer();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `image conversion timed out after ${CONVERSION_TIMEOUT_MS}ms`,
        ),
      );
    }, CONVERSION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([pipeline, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
