/**
 * On-device install-tree layout for the curl-installed Friday (FRI-146 /
 * ADR-033). This is the code/distribution tree — SEPARATE from `~/.friday/`
 * user data (`FRIDAY_DATA_DIR`).
 *
 *   ~/.local/share/friday/
 *     versions/<version>/   ← extracted pre-baked tarballs (one per release)
 *     current               ← symlink → versions/<version> (only `friday
 *                             update` ever flips this)
 *   ~/.local/bin/friday     ← PATH shim
 *
 * `install.sh` produces this layout; `friday update` / `friday uninstall`
 * operate on it. Keep in sync with install.sh.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** `~/.local/share/friday`. */
export function installRoot(): string {
  return join(homedir(), ".local", "share", "friday");
}

/** `~/.local/share/friday/versions`. */
export function versionsDir(): string {
  return join(installRoot(), "versions");
}

/** `~/.local/share/friday/versions/<version>`. */
export function versionDir(version: string): string {
  return join(versionsDir(), version);
}

/** `~/.local/share/friday/current` (the symlink path itself, not its
 *  target). */
export function currentLink(): string {
  return join(installRoot(), "current");
}

/** `~/.local/bin/friday` PATH shim. */
export function pathShim(): string {
  return join(homedir(), ".local", "bin", "friday");
}
