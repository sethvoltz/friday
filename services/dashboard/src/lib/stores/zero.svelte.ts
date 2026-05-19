/**
 * Zero sync client bound to Svelte 5 `$state`. Single WS connection to
 * zero-cache (authenticated via the JWT minted by `/api/sync/refresh`)
 * underlying multiple reactive collections exposed as `$state`
 * properties on the `zeroSync` singleton.
 *
 * Slices currently active:
 *   - Phase 2: `agents` (sidebar; mirrors into `chat.agents` for the
 *     existing Sidebar component).
 *   - Phase 3.1: `tickets` (the /tickets list page; detail page
 *     follows once row-level queries land).
 *
 * Feature flag (one switch for all slices):
 *   - `PUBLIC_FRIDAY_USE_ZERO=1` env var, OR
 *   - `localStorage["friday:flag:use-zero"]=1` (dev override; survives
 *     reload).
 *
 * The legacy `useZeroSidebar()` and `friday:flag:use-zero-sidebar` key
 * stay as fallback aliases so the Phase 2 smoke flag still works.
 */

import { browser } from "$app/environment";
import { Zero, createBuilder } from "@rocicorp/zero";
import { schema, type Schema } from "@friday/shared/sync";
import { chat, type AgentInfo } from "./chat.svelte";

const queries = createBuilder(schema);

/** Row shape mirrors the `agents` Zero table definition. Kept narrow:
 *  Phase 2 only reads the columns the sidebar needs. */
export interface ZeroAgentRow {
  name: string;
  type: string;
  status: string;
  session_id: string | null;
  created_at: number;
  updated_at: number;
}

/** Row shape mirrors the `tickets` Zero table definition. */
export interface ZeroTicketRow {
  id: string;
  title: string;
  body: string | null;
  status: "open" | "in_progress" | "done" | "blocked" | "closed";
  kind: "task" | "epic" | "bug" | "chore";
  assignee: string | null;
  meta_json: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
}

interface RefreshResponse {
  token: string;
  deviceId: string;
  expiresAt: number;
}

class ZeroSyncStore {
  /** Live agent rows from Zero, filtered server-side to non-archived. */
  agents = $state<ZeroAgentRow[]>([]);

  /** Live ticket rows from Zero (Phase 3.1). */
  tickets = $state<ZeroTicketRow[]>([]);

  /** Connection status of the underlying Zero client. `pending` until
   *  the first materialization, `live` once a snapshot has been
   *  delivered, `error` when the WS bridge is unhealthy. */
  status = $state<"pending" | "live" | "error">("pending");

  /** When `status === "error"`, the message captured from the
   *  exception that put us there. Exposed for the dev devtools probe
   *  + a future Settings → Sync health surface. */
  errorMessage = $state<string | null>(null);

  #zero: Zero<Schema> | null = null;
  #unsubscribers: Array<() => void> = [];

  constructor() {
    if (!browser) return;
    if (!useZero()) return;
    void this.#init();
  }

  async #init(): Promise<void> {
    try {
      // Mint the first JWT eagerly so the WS handshake succeeds on
      // first connect. The Zero `auth` callback re-fetches on every
      // reconnect — TTL is 15 minutes so the auth callback fires on
      // a long-running session occasionally.
      const r = await fetch("/api/sync/refresh", { method: "POST" });
      if (!r.ok) {
        this.status = "error";
        return;
      }
      const { deviceId } = (await r.json()) as RefreshResponse;
      this.#zero = new Zero<Schema>({
        schema,
        server: zeroServerUrl(),
        auth: refreshToken,
        userID: deviceId,
        kvStore: "mem", // Phase 6 promotes to IDB for offline cache.
      });

      this.#bindAgents();
      this.#bindTickets();
      this.status = "live";
    } catch (err) {
      this.status = "error";
      this.errorMessage = err instanceof Error ? err.message : String(err);
      // Surface unexpected init failures in dev — Phase 6 will route
      // these through the connectivity widget.
      // eslint-disable-next-line no-console
      console.error("[zeroSync] init failed:", err);
    }
  }

  #bindAgents(): void {
    if (!this.#zero) return;
    const query = queries.agents.where("status", "!=", "archived");
    const preload = this.#zero.preload(query);
    const view = this.#zero.materialize(query);
    const update = (data: readonly unknown[]): void => {
      const rows = data as readonly ZeroAgentRow[];
      this.agents = rows as ZeroAgentRow[];
      // Mirror into chat.agents (existing AgentInfo shape) so the
      // existing Sidebar component renders Zero data without code
      // changes — the sidebar's REST poll is gated behind the same
      // feature flag and is skipped when Zero is active.
      chat.agents = rows.map(toAgentInfo);
    };
    update(view.data as readonly unknown[]);
    view.addListener((data) => update(data as readonly unknown[]));
    this.#unsubscribers.push(() => {
      preload.cleanup();
      view.destroy();
    });
  }

  #bindTickets(): void {
    if (!this.#zero) return;
    const query = queries.tickets;
    const preload = this.#zero.preload(query);
    const view = this.#zero.materialize(query);
    const update = (data: readonly unknown[]): void => {
      const rows = data as readonly ZeroTicketRow[];
      this.tickets = rows as ZeroTicketRow[];
    };
    update(view.data as readonly unknown[]);
    view.addListener((data) => update(data as readonly unknown[]));
    this.#unsubscribers.push(() => {
      preload.cleanup();
      view.destroy();
    });
  }

  destroy(): void {
    for (const unsub of this.#unsubscribers) unsub();
    this.#unsubscribers = [];
    this.#zero?.close();
    this.#zero = null;
  }
}

/** Convert a Zero row from the `agents` table to the existing
 *  `AgentInfo` shape the sidebar (and the rest of the dashboard)
 *  already consumes. Phase 2: keep the shape compatible so we can
 *  flip the data source without rewriting downstream components. */
function toAgentInfo(r: ZeroAgentRow): AgentInfo {
  return {
    name: r.name,
    type: r.type,
    status: r.status,
    sessionId: r.session_id ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

async function refreshToken(): Promise<string> {
  const r = await fetch("/api/sync/refresh", { method: "POST" });
  if (!r.ok) throw new Error(`refresh failed: ${r.status}`);
  const body = (await r.json()) as RefreshResponse;
  return body.token;
}

function zeroServerUrl(): string {
  // Read at module load — Vite inlines PUBLIC_* env vars at build time.
  // Zero 1.5 expects an http(s) URL (the protocol upgrades to WS during
  // handshake); passing `ws://` throws `must use the "http" or "https"
  // scheme.`
  const env = (
    import.meta as unknown as { env?: Record<string, string | undefined> }
  ).env;
  return env?.PUBLIC_FRIDAY_ZERO_URL ?? "http://localhost:4848";
}

/**
 * Universal Zero opt-in. Phase 3 collapses what was originally
 * `useZeroSidebar()` (Phase 2) into a single switch — all slices that
 * have landed activate together.
 */
export function useZero(): boolean {
  if (!browser) return false;
  const env = (
    import.meta as unknown as { env?: Record<string, string | undefined> }
  ).env;
  if (env?.PUBLIC_FRIDAY_USE_ZERO === "1" || env?.PUBLIC_FRIDAY_USE_ZERO === "true")
    return true;
  // Phase 2 alias kept for backward compat with the original smoke flag.
  if (
    env?.PUBLIC_FRIDAY_USE_ZERO_SIDEBAR === "1" ||
    env?.PUBLIC_FRIDAY_USE_ZERO_SIDEBAR === "true"
  )
    return true;
  // localStorage override for dev — either of the two keys works.
  try {
    if (localStorage.getItem("friday:flag:use-zero") === "1") return true;
    if (localStorage.getItem("friday:flag:use-zero-sidebar") === "1") return true;
  } catch {
    // ignore
  }
  return false;
}

/**
 * @deprecated Use {@linkcode useZero}. Kept so existing Phase 2 call
 * sites keep working without churn.
 */
export const useZeroSidebar = useZero;

export const zeroSync = new ZeroSyncStore();

// Dev probe: expose the singleton on `window` so devtools and Playwright
// probes can read its state without having to re-import the module
// (Vite gives each import path its own instance, defeating in-page
// inspection). Removed in Phase 6 when the connectivity widget surfaces
// the same signals natively.
if (browser) {
  (
    globalThis as unknown as { __fridayZero?: ZeroSyncStore }
  ).__fridayZero = zeroSync;
}

/**
 * @deprecated Use {@linkcode zeroSync}. Same singleton; the Phase 2
 * name is preserved for backward compat with the Sidebar component.
 */
export const zeroSidebar = zeroSync;
