// Copies markdown prompt files from src/prompts to dist/prompts so they're
// resolvable at runtime when consumers import the built package.
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, "..", "src", "prompts");
const dest = join(__dirname, "..", "dist", "prompts");

if (existsSync(src)) {
  cpSync(src, dest, { recursive: true });
}
