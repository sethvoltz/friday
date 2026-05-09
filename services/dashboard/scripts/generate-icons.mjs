#!/usr/bin/env node
/**
 * Regenerate PWA icons under services/dashboard/static/.
 *
 * Default behavior: render a placeholder monogram from the inline SVG below.
 * To use a real logo, pass --source=path/to/logo.svg (or PNG).
 *
 *   node scripts/generate-icons.mjs
 *   node scripts/generate-icons.mjs --source=../../../docs/friday-logo.svg
 *
 * Outputs:
 *   static/icon-192.png
 *   static/icon-512.png
 *   static/icon-maskable-512.png   (with ~80% safe zone for Android adaptive)
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, "..", "static");

const PLACEHOLDER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1f2933"/>
      <stop offset="100%" stop-color="#3e4c59"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="96" fill="url(#bg)"/>
  <text x="256" y="296"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        font-size="280" font-weight="700"
        text-anchor="middle" fill="#f5f7fa">F</text>
</svg>
`.trim();

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

async function loadSource() {
  if (typeof args.source === "string") {
    const p = resolve(args.source);
    if (!existsSync(p)) {
      throw new Error(`source not found: ${p}`);
    }
    return readFileSync(p);
  }
  return Buffer.from(PLACEHOLDER_SVG);
}

async function main() {
  const src = await loadSource();

  await sharp(src)
    .resize(192, 192, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(join(STATIC_DIR, "icon-192.png"));
  await sharp(src)
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(join(STATIC_DIR, "icon-512.png"));

  // Maskable: render the source onto an opaque-background canvas with ~80%
  // inner safe zone so Android's adaptive icon mask doesn't crop content.
  const safe = Math.round(512 * 0.8);
  const inner = await sharp(src).resize(safe, safe, { fit: "contain" }).png().toBuffer();
  await sharp({
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: { r: 31, g: 41, b: 51, alpha: 1 }, // matches placeholder bg
    },
  })
    .composite([{ input: inner, gravity: "center" }])
    .png()
    .toFile(join(STATIC_DIR, "icon-maskable-512.png"));

  console.log("Wrote icons to", STATIC_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
