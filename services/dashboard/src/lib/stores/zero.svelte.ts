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
import { Zero } from "@rocicorp/zero";
import {
  createMutators,
  schema,
  type Mutators,
  type Schema,
} from "@friday/shared/sync";
import { chat, type AgentInfo, type ZeroBlocksRow } from "./chat.svelte";

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

/** Row shape mirrors the `schedules` Zero table definition. */
export interface ZeroScheduleRow {
  name: string;
  cron: string | null;
  run_at: string | null;
  task_prompt: string;
  paused: boolean;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_id: string | null;
  meta_json: Record<string, unknown> | null;
  app_id: string | null;
  status:
    | "active"
    | "pending_register"
    | "reload_requested"
    | "deleted"
    | "paused";
  created_at: number;
  updated_at: number;
}

/** Row shape mirrors the `memory_entries` Zero table definition. */
export interface ZeroMemoryEntryRow {
  id: string;
  title: string;
  content: string;
  tags_json: string[];
  created_by: string;
  created_at: number;
  updated_at: number;
  file_mtime: number;
  recall_count: number;
  last_recalled_at: number | null;
  status: "ready" | "pending_file" | "deleted";
}

/** Row shape mirrors the `read_cursors` Zero table definition (Phase 4.1).
 *  Per-device, per-agent — primary key is (device_id, agent_name). */
export interface ZeroReadCursorRow {
  device_id: string;
  agent_name: string;
  last_seen_block_id: string;
  ts: number;
}

/** Row shape mirrors the `apps` Zero table definition. */
export interface ZeroAppRow {
  id: string;
  name: string;
  version: string;
  manifest_version: number;
  folder_path: string;
  manifest_json: {
    name?: string;
    version?: string;
    mcpServers?: Array<{ name: string }>;
  } | null;
  status:
    | "installed"
    | "orphaned"
    | "error"
    | "pending_install"
    | "uninstall_requested"
    | "reload_requested";
  installed_at: number;
  upgraded_at: number | null;
  meta_json: Record<string, unknown> | null;
}

interface RefreshResponse {
  token: string;
  deviceId: string;
  userId: string;
  expiresAt: number;
}

class ZeroSyncStore {
  /** Live agent rows from Zero, filtered server-side to non-archived. */
  agents = $state<ZeroAgentRow[]>([]);

  /** Live ticket rows from Zero (Phase 3.1). */
  tickets = $state<ZeroTicketRow[]>([]);

  /** Live schedule rows from Zero (Phase 3.2). */
  schedules = $state<ZeroScheduleRow[]>([]);

  /** Live memory_entries rows from Zero (Phase 3.3). */
  memory = $state<ZeroMemoryEntryRow[]>([]);

  /** Live apps rows from Zero (Phase 3.4). */
  apps = $state<ZeroAppRow[]>([]);

  /** Live read_cursors rows from Zero (Phase 4.1). All devices for
   *  the current user — the per-device unread derivation filters
   *  client-side by `device_id === this.#deviceId`. */
  readCursors = $state<ZeroReadCursorRow[]>([]);

  /** Live blocks rows for the currently-focused agent (Phase 3.7).
   *  Bound dynamically by {@linkcode bindBlocksFor}; empty when no agent
   *  is focused or when {@linkcode unbindBlocks} has been called. */
  blocks = $state<ZeroBlocksRow[]>([]);

  /** Which agent's blocks the current {@linkcode blocks} view is bound to,
   *  or `null` when no binding is active. The chat store inspects this
   *  to decide whether a focus-switch needs to rebind. */
  blocksAgent = $state<string | null>(null);

  /** Connection status of the underlying Zero client. `pending` until
   *  the first materialization, `live` once a snapshot has been
   *  delivered, `error` when the WS bridge is unhealthy. */
  status = $state<"pending" | "live" | "error">("pending");

  /** When `status === "error"`, the message captured from the
   *  exception that put us there. Exposed for the dev devtools probe
   *  + a future Settings → Sync health surface. */
  errorMessage = $state<string | null>(null);

  #zero: Zero<Schema, Mutators> | null = null;
  /** Per-tab device id (from `/api/sync/refresh`). Used by mutators
   *  that scope writes to "this device" — markRead, reportClientStats,
   *  forgetDevice. Set in `#init` once `/api/sync/refresh` resolves;
   *  null before that. */
  #deviceId: string | null = null;
  #unsubscribers: Array<() => void> = [];
  /** Tear-down handle for the per-agent {@linkcode blocks} view. Held
   *  separately from `#unsubscribers` because focus-switch destroys
   *  this binding without tearing down the global slices. */
  #blocksTeardown: (() => void) | null = null;
  /** Listeners notified on every blocks-view update (initial snapshot
   *  + every subsequent reactive frame). Used by the chat store to
   *  merge Zero rows into `chat.messages` without re-subscribing on
   *  every reactive read. */
  #blocksListeners = new Set<(rows: ZeroBlocksRow[]) => void>();
  /**
   * When `bindBlocksFor` is called before `#init` resolves (the typical
   * cold-load race — the chat shell mounts the moment SvelteKit hands
   * control over, but `#init` has to await `/api/sync/refresh` before
   * `#zero` is constructed), we remember the requested agent here and
   * apply the binding once init completes. Without this, the cold-load
   * call lands when `#zero` is still null, the early-return fires
   * silently, and Phase 3.7's chat-history path stays unbound for the
   * lifetime of the page (the binder won't fire again until the user
   * navigates between agents).
   */
  #pendingBlocksAgent: string | null = null;

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
      const { token, userId, deviceId } = (await r.json()) as RefreshResponse;
      this.#deviceId = deviceId;
      // Zero 1.5: `auth` is a JWT string, not a callback. Token
      // rotation happens via `zero.connection.connect({auth})` when
      // zero-cache returns 401/403. Phase 6 wires that listener; the
      // 15-min TTL gives Phase 3 plenty of soak time before rotation
      // matters. `userID` MUST match the JWT's `sub` claim; the
      // refresh endpoint puts BetterAuth's user id in both.
      //
      // `mutators` is the Phase 4.1+ write path: every entry from
      // `createMutators()` becomes callable on `this.#zero.mutate`.
      // The mutator runs once optimistically on the client + once
      // canonically on the server (dashboard's `/api/mutators` push
      // handler routes the server-side execution).
      this.#zero = new Zero<Schema, Mutators>({
        schema,
        mutators: createMutators(),
        server: zeroServerUrl(),
        auth: token,
        userID: userId,
        kvStore: "mem", // Phase 6 promotes to IDB for offline cache.
      });

      this.#bindAgents();
      this.#bindTickets();
      this.#bindSchedules();
      this.#bindMemory();
      this.#bindApps();
      this.#bindReadCursors();
      this.status = "live";
      // Apply any blocks-binding the chat shell asked for while
      // `#init` was still running. Cold-load order is:
      //   1. ChatShell mounts, $effect fires, calls
      //      `chat.loadAgentTurns(agent)`.
      //   2. `loadAgentTurns` calls `chat.blocksBinder(agent)`.
      //   3. The binder calls `zeroSync.bindBlocksFor(agent)`.
      //   4. `bindBlocksFor` early-returns because `#zero` is still
      //      null (init hasn't resolved the JWT fetch + Zero ctor).
      // Without the pending-agent recovery here, step 4 silently
      // discards the binding and the user sees the local-cache
      // first-paint forever (no live updates from Zero).
      if (this.#pendingBlocksAgent) {
        const agent = this.#pendingBlocksAgent;
        this.#pendingBlocksAgent = null;
        this.bindBlocksFor(agent);
      }
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
    // `enableLegacyQueries: true` in the shared sync schema gives us
    // the connection-bound `z.query.<table>` field; the alternative
    // `createBuilder(schema)` path returns unbound builders that
    // register 0 desired queries with zero-cache.
    const query = this.#zero.query.agents.where("status", "!=", "archived");
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
    const query = this.#zero.query.tickets;
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

  #bindSchedules(): void {
    if (!this.#zero) return;
    const query = this.#zero.query.schedules;
    const preload = this.#zero.preload(query);
    const view = this.#zero.materialize(query);
    const update = (data: readonly unknown[]): void => {
      const rows = data as readonly ZeroScheduleRow[];
      this.schedules = rows as ZeroScheduleRow[];
    };
    update(view.data as readonly unknown[]);
    view.addListener((data) => update(data as readonly unknown[]));
    this.#unsubscribers.push(() => {
      preload.cleanup();
      view.destroy();
    });
  }

  #bindMemory(): void {
    if (!this.#zero) return;
    // Filter out tombstoned `deleted` rows server-side so the
    // dashboard list isn't pre-filled with hidden entries the user
    // already forgot. Recovery / undelete is Phase 4 work.
    const query = this.#zero.query.memory_entries.where(
      "status",
      "!=",
      "deleted",
    );
    const preload = this.#zero.preload(query);
    const view = this.#zero.materialize(query);
    const update = (data: readonly unknown[]): void => {
      const rows = data as readonly ZeroMemoryEntryRow[];
      this.memory = rows as ZeroMemoryEntryRow[];
    };
    update(view.data as readonly unknown[]);
    view.addListener((data) => update(data as readonly unknown[]));
    this.#unsubscribers.push(() => {
      preload.cleanup();
      view.destroy();
    });
  }

  #bindApps(): void {
    if (!this.#zero) return;
    const query = this.#zero.query.apps;
    const preload = this.#zero.preload(query);
    const view = this.#zero.materialize(query);
    const update = (data: readonly unknown[]): void => {
      const rows = data as readonly ZeroAppRow[];
      this.apps = rows as ZeroAppRow[];
    };
    update(view.data as readonly unknown[]);
    view.addListener((data) => update(data as readonly unknown[]));
    this.#unsubscribers.push(() => {
      preload.cleanup();
      view.destroy();
    });
  }

  #bindReadCursors(): void {
    if (!this.#zero) return;
    // Global query (no `where`) — Friday is single-user, the row set
    // is bounded by `(device_count * agent_count)`. Per-device
    // filtering for the unread badge derivation happens client-side
    // off `this.#deviceId`.
    const query = this.#zero.query.read_cursors;
    const preload = this.#zero.preload(query);
    const view = this.#zero.materialize(query);
    const update = (data: readonly unknown[]): void => {
      const rows = data as readonly ZeroReadCursorRow[];
      this.readCursors = rows as ZeroReadCursorRow[];
    };
    update(view.data as readonly unknown[]);
    view.addListener((data) => update(data as readonly unknown[]));
    this.#unsubscribers.push(() => {
      preload.cleanup();
      view.destroy();
    });
  }

  /**
   * Bind (or rebind) the per-agent blocks reactive query. Tears down
   * the prior binding first so a focus switch from agent A → B doesn't
   * leak A's view-syncer subscription. Filters out `status='streaming'`
   * placeholder rows (ADR-024: those are the in-flight markers the
   * daemon writes on `block_start` and finalizes at `block_complete`;
   * the chat should only render canonical rows).
   *
   * The reactive view materializes the last 50 blocks for the focused
   * agent. Scroll-back beyond that window is served by the REST endpoint
   * (`GET /api/agents/:name/blocks?before=…`) and merged into the
   * dashboard's chat state by the existing `loadOlderTurns` path.
   */
  bindBlocksFor(agentName: string): void {
    if (!this.#zero) {
      // Defer: `#init` is still in flight. The last write wins so a
      // rapid focus-switch (A → B → C before init resolves) ends up
      // bound to C, which matches what the user would expect.
      this.#pendingBlocksAgent = agentName;
      return;
    }
    if (this.blocksAgent === agentName && this.#blocksTeardown) return;
    this.unbindBlocks();
    this.blocksAgent = agentName;
    // `this.unbindBlocks()` above invalidates TS's narrowing of
    // `this.#zero` because it touches `this`, so the per-line reads
    // below trip the same "possibly undefined" lint as the other
    // `#bind*` methods (this is a pre-existing pattern, not new
    // sloppiness — the early-return at top guarantees non-null).
    const query = this.#zero.query.blocks
      .where("agent_name", "=", agentName)
      .where("status", "!=", "streaming")
      .orderBy("id", "desc")
      .limit(50);
    const preload = this.#zero.preload(query);
    const view = this.#zero.materialize(query);
    const update = (data: readonly unknown[]): void => {
      const rows = data as readonly ZeroBlocksRow[];
      this.blocks = rows as ZeroBlocksRow[];
      for (const listener of this.#blocksListeners) listener(this.blocks);
    };
    update(view.data as readonly unknown[]);
    view.addListener((data) => update(data as readonly unknown[]));
    this.#blocksTeardown = (): void => {
      preload.cleanup();
      view.destroy();
    };
  }

  /** Release the per-agent blocks subscription. Idempotent on a
   *  no-op when nothing is currently bound. Also drops any deferred
   *  pre-init binding request — otherwise an `unbindBlocks` before
   *  init resolves would be silently overridden by the queued bind. */
  unbindBlocks(): void {
    this.#pendingBlocksAgent = null;
    if (this.#blocksTeardown) {
      this.#blocksTeardown();
      this.#blocksTeardown = null;
    }
    this.blocksAgent = null;
    this.blocks = [];
  }

  /** Register a listener that fires on every blocks-view update. Returns
   *  an unsubscribe function. Listeners are notified synchronously on
   *  registration with the current snapshot so callers don't miss the
   *  initial frame. */
  onBlocksUpdate(listener: (rows: ZeroBlocksRow[]) => void): () => void {
    this.#blocksListeners.add(listener);
    listener(this.blocks);
    return () => {
      this.#blocksListeners.delete(listener);
    };
  }

  /**
   * Phase 4.1: mark blocks up to (and including) `blockId` as read for
   * the current device on the focused agent. UPSERTs the
   * `read_cursors` row keyed by (device_id, agent_name); the unread
   * badge derivation `blocks.count where id > read_cursor.last_seen`
   * zeroes on the next reactive frame.
   *
   * Per ADR-023 open-question default, this is per-device: marking
   * read on phone does NOT clear the badge on laptop. Multi-device
   * users see the cursor row land on both — which device "wins" the
   * highest-block-id depends on which one viewed last.
   *
   * No-op (silently dropped) if:
   *   - Zero hasn't finished init (no `#zero`, no `#deviceId`).
   *   - `useZero()` is false (Zero disabled — legacy unread bookkeeping
   *     in `chat.unreadByAgent` still owns the state).
   *
   * The "Phase 4.1 doesn't fire until Zero is live" miss is acceptable
   * because the unread state itself is server-derived only when Zero
   * is on; without Zero, `chat.clearUnread(name)` (called by the
   * sidebar's focus handler) still owns the path.
   */
  markRead(agentName: string, blockId: string): void {
    if (!this.#zero || !this.#deviceId) return;
    void this.#zero.mutate.markRead({
      deviceId: this.#deviceId,
      agentName,
      lastSeenBlockId: blockId,
      ts: Date.now(),
    });
  }

  destroy(): void {
    for (const unsub of this.#unsubscribers) unsub();
    this.#unsubscribers = [];
    this.unbindBlocks();
    this.#blocksListeners.clear();
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

// Phase 3.7: wire the chat store's per-agent blocks integration. Chat
// can't import this module directly (zero.svelte.ts already imports
// chat.svelte.ts), so we register the binding + listener here at module
// init. Skipped when Zero is disabled — the chat store's REST path then
// owns the read flow as it did pre-Phase-3.
if (browser && useZero()) {
  chat.setBlocksBinder((agent: string | null) => {
    if (agent) zeroSync.bindBlocksFor(agent);
    else zeroSync.unbindBlocks();
  });
  zeroSync.onBlocksUpdate((rows) => {
    const agent = zeroSync.blocksAgent;
    if (!agent) return;
    chat.applyZeroBlocks(rows, agent);
  });
  // Phase 4.1: register the markRead callback. Chat calls this from
  // `applyZeroBlocks` after each per-agent snapshot to advance the
  // read cursor to the newest block. Same circular-dep avoidance
  // pattern as the binder: chat doesn't import zero.
  chat.setMarkReadFn((agent, blockId) => zeroSync.markRead(agent, blockId));
}

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
