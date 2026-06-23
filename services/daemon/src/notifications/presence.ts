// FRI-142 / ADR-048 — Server-side presence tracker (daemon-only, in-memory).
//
// Whether the user is actively viewing the app RIGHT NOW, used by the
// Notification router to choose Toast over Push. Presence is:
//
//   - SERVER-SIDE & IN-MEMORY. A high-churn, ephemeral signal — replicating
//     heartbeats through Zero/Postgres would be pure waste (ADR-048 Rejected:
//     "persisting presence to Postgres"). The daemon's Map is canonical.
//   - MULTI-CLIENT, OR-AGGREGATED PER USER. Present iff ANY one of a user's
//     devices is fresh AND visible; absent requires EVERY device absent.
//   - FAIL-SAFE. Stale (past TTL), unknown, or empty (a daemon restart) ⇒
//     treated as AWAY ⇒ Push. Presence can only ever DOWNGRADE a Push to a
//     Toast, never the reverse — a missed Toast is acceptable, a missed Push
//     is not (the load-bearing WebKit constraint: every push must render).
//
// It MUST be server-side because WebKit renders a user-visible notification for
// every web push — a foregrounded device cannot silently swap push→toast, so
// the daemon must decide whether to push AT ALL (ADR-048).
//
// The Map is keyed by deviceId. We don't store the userId→deviceId mapping here
// (a device reports only its own id + visibility); the router resolves a user's
// device set from `client_devices` and asks `isUserPresent(deviceIds)`.

import type { PresenceReport } from "@friday/shared";
import { logger } from "../log.js";

/** Per-device liveness record. `lastSeen` is wall-clock ms (Date.now()). */
interface DevicePresence {
  lastSeen: number;
  visible: boolean;
}

/**
 * TTL after which a heartbeat is considered stale (fail-safe ⇒ away). The
 * client keepalive is ~20s (FRI-142 default 1(a)); the TTL is 45s so a SINGLE
 * missed beat does not flip a present user to absent — presence and the SSE
 * liveness clock share a cadence (CLAUDE.md: matches `sseKeepaliveSec` ≈ 20s).
 */
export const PRESENCE_TTL_MS = 45_000;

/** deviceId → its latest heartbeat. In-memory only; a daemon restart empties
 *  it ⇒ every user reads absent ⇒ safe over-push. */
const devices = new Map<string, DevicePresence>();

/**
 * Test-/injection-only clock seam so a TTL-expiry test drives wall-clock
 * deterministically without `vi.useFakeTimers` leaking across the IO boundary.
 * Production uses `Date.now`.
 */
let now: () => number = () => Date.now();

/** Record one client→daemon presence heartbeat (POST /api/presence body). The
 *  `lastSeen` stamp is taken at receipt; `visible` is the client's foreground
 *  state at send time. Overwrites any prior record for the same device. */
export function reportPresence(report: PresenceReport): void {
  if (!report.deviceId) return;
  devices.set(report.deviceId, { lastSeen: now(), visible: report.visible });
  logger.log("debug", "presence.report", {
    deviceId: report.deviceId,
    visible: report.visible,
  });
}

/** True iff this single device is fresh (within TTL) AND visible. The atom the
 *  per-user OR-aggregation is built from. */
function isDeviceFresh(deviceId: string): boolean {
  const rec = devices.get(deviceId);
  if (!rec) return false;
  if (!rec.visible) return false;
  return now() - rec.lastSeen <= PRESENCE_TTL_MS;
}

/**
 * OR-aggregate presence across a user's device set: present iff ANY device in
 * `deviceIds` is fresh AND visible. An EMPTY device set (no known devices, or a
 * post-restart empty Map) ⇒ false ⇒ away ⇒ push (fail-safe). The router passes
 * the user's `client_devices` device ids here.
 */
export function isUserPresent(deviceIds: readonly string[]): boolean {
  for (const id of deviceIds) {
    if (isDeviceFresh(id)) return true;
  }
  return false;
}

/**
 * GLOBAL presence: is ANY reporting device fresh AND visible right now? Used for
 * the broadcast TOAST decision, which is correct on a single-user system — a
 * toast rides the single SSE side-channel and reaches every connected client,
 * so the only question is "is a client foregrounded at all". This is
 * deliberately INDEPENDENT of the push-subscription user set: a client that
 * reports presence but never subscribed to Web Push (the common fresh-install
 * case) still gets toasts. Empty Map (restart / nobody reporting) ⇒ false.
 */
export function isAnyDevicePresent(): boolean {
  for (const id of devices.keys()) {
    if (isDeviceFresh(id)) return true;
  }
  return false;
}

/** Test-only: install a deterministic clock for the TTL-expiry interleaving. */
export function __setPresenceClockForTest(clock: () => number): void {
  now = clock;
}

/** Test-only: clear the in-memory Map + restore the real clock (the daemon-
 *  restart / clean-slate case). */
export function __resetPresenceForTest(): void {
  devices.clear();
  now = () => Date.now();
}
