/**
 * `friday uninstall` — tear down the curl-installed Friday (FRI-146 /
 * ADR-034). Removes the supervision job + the distribution tree, but
 * PRESERVES `~/.friday/` user data by default (mirrors
 * `friday app uninstall --folder=keep`).
 *
 * Removed:
 *   - `~/Library/LaunchAgents/com.sethvoltz.friday.plist` (after `launchctl
 *     bootout`)
 *   - `~/.local/bin/friday` PATH shim
 *   - `~/.local/share/friday/` (all version dirs + the `current` symlink)
 *
 * Preserved (unless `--data=delete`, prompted, default keep):
 *   - `~/.friday/` (or `$FRIDAY_DATA_DIR`) — the user's data dir
 *
 * The data-disposition prompt defaults to KEEP. `--data=delete` (with a
 * `@clack/prompts` confirm, or `--yes` to skip it) is the only path that
 * touches user data.
 */

import { defineCommand } from "citty";
import { confirm, isCancel } from "@clack/prompts";
import pc from "picocolors";
import { existsSync, rmSync } from "node:fs";
import { DATA_DIR } from "@friday/shared";
import * as launchd from "../lib/launchd.js";
import { installRoot, pathShim } from "../lib/install-paths.js";

type DataDisposition = "keep" | "delete";

export interface UninstallResult {
  removed: string[];
  preserved: string[];
}

/** Core teardown, separated from the CLI shell for testability. Removes the
 *  plist + shim + install tree; deletes `~/.friday/` only when
 *  `data === "delete"`. */
export function runUninstall(data: DataDisposition): UninstallResult {
  const removed: string[] = [];
  const preserved: string[] = [];

  // Stop + unload the supervisor before removing its plist.
  launchd.bootout();
  const plist = launchd.plistPath();
  if (existsSync(plist)) {
    rmSync(plist, { force: true });
    removed.push(plist);
  }

  const shim = pathShim();
  if (existsSync(shim)) {
    rmSync(shim, { force: true });
    removed.push(shim);
  }

  const root = installRoot();
  if (existsSync(root)) {
    rmSync(root, { recursive: true, force: true });
    removed.push(root);
  }

  if (data === "delete") {
    if (existsSync(DATA_DIR)) {
      rmSync(DATA_DIR, { recursive: true, force: true });
      removed.push(DATA_DIR);
    }
  } else {
    // PRESERVE — the default. Report it even if it doesn't exist so the
    // operator sees what was spared.
    preserved.push(DATA_DIR);
  }

  return { removed, preserved };
}

export const uninstallCommand = defineCommand({
  meta: {
    name: "uninstall",
    description:
      "Remove Friday's supervisor + install tree. Preserves ~/.friday user data by default (--data=delete to remove it).",
  },
  args: {
    data: {
      type: "string",
      default: "keep",
      description: "What to do with ~/.friday user data: keep (default) | delete",
    },
    yes: {
      type: "boolean",
      default: false,
      description: "Skip the confirmation prompt for --data=delete",
    },
  },
  async run({ args }) {
    const data = args.data as string;
    if (data !== "keep" && data !== "delete") {
      console.error(pc.red(`invalid --data: ${data} (expected keep | delete)`));
      process.exit(1);
    }

    if (data === "delete" && !args.yes) {
      const ok = await confirm({
        message: pc.red(`--data=delete will PERMANENTLY remove ${DATA_DIR}. Proceed?`),
        initialValue: false,
      });
      if (isCancel(ok) || !ok) {
        console.log(pc.dim("aborted — nothing removed"));
        return;
      }
    }

    const { removed, preserved } = runUninstall(data as DataDisposition);

    console.log(pc.bold("friday uninstall"));
    for (const r of removed) console.log(`  ${pc.red("removed")}    ${r}`);
    for (const p of preserved) console.log(`  ${pc.green("preserved")}  ${p}`);
    if (removed.length === 0) {
      console.log(pc.dim("  nothing to remove — Friday was not installed via the curl installer"));
    }
  },
});
