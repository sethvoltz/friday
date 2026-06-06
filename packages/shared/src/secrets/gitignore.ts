import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";

const SECRETS_ALLOW_BLOCK = ["!secrets/", "!secrets/**", "secrets/.generation"] as const;

export function patchFridayGitignore(): { changed: boolean; removedEnvAllow: boolean } {
  const path = join(DATA_DIR, ".gitignore");
  if (!existsSync(path)) {
    writeFileSync(
      path,
      [
        "# Start by ignoring everything, un-ignoring what we want tracked.",
        "*",
        "!.gitignore",
        ...SECRETS_ALLOW_BLOCK,
        "",
      ].join("\n"),
    );
    return { changed: true, removedEnvAllow: false };
  }

  let lines = readFileSync(path, "utf8").split("\n");
  let changed = false;
  let removedEnvAllow = false;

  const withoutEnvAllow = lines.filter((line) => {
    if (line.trim() === "!.env.*") {
      removedEnvAllow = true;
      changed = true;
      return false;
    }
    return true;
  });
  lines = withoutEnvAllow;

  for (const blockLine of SECRETS_ALLOW_BLOCK) {
    if (!lines.some((l) => l.trim() === blockLine)) {
      lines.push(blockLine);
      changed = true;
    }
  }

  if (changed) {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  }

  return { changed, removedEnvAllow };
}
