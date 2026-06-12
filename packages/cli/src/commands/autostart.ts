import { defineCommand } from "citty";
import pc from "picocolors";
import * as launchd from "../lib/launchd.js";
import { currentLink } from "../lib/install-paths.js";

/**
 * `friday disable` / `friday enable` — control whether Friday auto-launches at
 * login WITHOUT touching the install tree or `~/.friday` data.
 *
 * Autostart is the launchd plist's `RunAtLoad` (`~/Library/LaunchAgents/
 * com.sethvoltz.friday.plist`). `friday stop` only boots the job OUT of the
 * current login session — the plist stays on disk, so launchd re-launches it
 * at the next login/reboot. To keep Friday installed (e.g. to test `friday
 * update`) but NOT auto-run, you must remove the plist; these commands do that
 * cleanly and reversibly.
 *
 *   disable → bootout + remove the plist (stopped now, won't auto-launch).
 *   enable  → re-write the plist (autostart armed) WITHOUT starting now;
 *             `friday start` both arms and launches.
 *
 * `friday update` is autostart-aware: when Friday is stopped it only refreshes
 * an EXISTING plist, so an update can't resurrect a disabled one.
 */

export const disableCommand = defineCommand({
  meta: {
    name: "disable",
    description: "Stop Friday and disable auto-launch at login (keeps the install + data).",
  },
  async run() {
    launchd.bootout();
    const had = launchd.plistExists();
    launchd.removePlist();
    if (had) {
      console.log(pc.green("✓ Friday disabled — stopped and won't auto-launch at login."));
    } else {
      console.log(
        pc.dim("Friday was already not auto-launching (no plist); ensured it's stopped."),
      );
    }
    console.log(
      pc.dim(
        `  install + data kept. ${pc.cyan("friday start")} to run it, or ${pc.cyan("friday enable")} to re-arm autostart without starting.`,
      ),
    );
  },
});

export const enableCommand = defineCommand({
  meta: {
    name: "enable",
    description: "Re-arm Friday's auto-launch at login (writes the plist; does not start it).",
  },
  async run() {
    try {
      launchd.writePlist(currentLink());
    } catch (err) {
      console.error(
        pc.red(`✗ could not write the launchd plist: ${err instanceof Error ? err.message : err}`),
      );
      process.exit(1);
    }
    console.log(pc.green("✓ Friday auto-launch enabled (starts at next login)."));
    console.log(
      pc.dim(`  not started now — run ${pc.cyan("friday start")} to launch it immediately.`),
    );
  },
});
