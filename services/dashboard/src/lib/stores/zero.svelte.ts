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
// `MutatorResult` was renamed in Zero 1.5 — the shape is identical
// (`{client, server}` Promise pair) but the export now lives under
// `PromiseWithServerResult`. Alias on import to keep the existing
// mutator-method return-type readable.
import type { PromiseWithServerResult as MutatorResult } from "@rocicorp/zero";
import { createMutators, schema, type Mutators, type Schema } from "@friday/shared/sync";
import { chat, type AgentInfo, type ZeroBlocksRow } from "./chat.svelte";
import { awaitMutatorServer } from "./mutator-result";
import { reconcileWakeLock } from "./wake-lock.svelte";

/** Row shape mirrors the `agents` Zero table definition. Kept narrow:
 *  Phase 2 only reads the columns the sidebar needs. Phase 6's
 *  Settings → Apps panel groups agents by `app_id`, so that column
 *  is exposed too. */
export interface ZeroAgentRow {
  name: string;
  type: string;
  status: string;
  session_id: string | null;
  app_id: string | null;
  session_count: number;
  created_at: number;
  updated_at: number;
}

/** Row shape mirrors the `ticket_comments` Zero table definition (Phase 4.4). */
export interface ZeroTicketCommentRow {
  id: string;
  ticket_id: string;
  author: string;
  body: string;
  ts: number;
}

/** Row shape mirrors the `ticket_external_links` Zero table definition (Phase 4.4). */
export interface ZeroTicketExternalLinkRow {
  ticket_id: string;
  system: string;
  external_id: string;
  url: string | null;
  meta_json: Record<string, unknown> | null;
  linked_at: number;
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
  status: "active" | "pending_register" | "reload_requested" | "deleted" | "paused";
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
  status: "ready" | "pending_file" | "pending_delete" | "deleted";
}

/** Row shape mirrors the `evolve_proposals` Zero table definition (item #54). */
export interface ZeroEvolveProposalRow {
  id: string;
  title: string;
  proposal_type: string;
  status: string;
  cluster_id: string | null;
  score: number;
  blast_radius: string;
  applies_to: string[];
  signals: unknown[];
  body: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  applied_at: number | null;
  applied_by: string | null;
  enriched_at: number | null;
  enriched_by: string | null;
  last_enrich_error: string | null;
  last_enrich_failed_at: number | null;
  applied_ticket_id: string | null;
}

/** Row shape mirrors the `read_cursors` Zero table definition (Phase 4.1).
 *  Per-device, per-agent — primary key is (device_id, agent_name). */
export interface ZeroReadCursorRow {
  device_id: string;
  agent_name: string;
  last_seen_block_id: string;
  ts: number;
  unread_count: number;
}

/** Row shape mirrors the `settings` Zero table definition (Phase 4.3).
 *  Single-row table — `id` is always `"singleton"`. */
export interface ZeroSettingsRow {
  id: string;
  model: string | null;
  watchdog_refork: boolean | null;
  updated_at: number;
}

/** Row shape mirrors the `client_devices` Zero table definition (Phase 4.2). */
export interface ZeroClientDeviceRow {
  device_id: string;
  user_id: string;
  user_agent: string | null;
  label: string | null;
  first_seen_at: number;
  last_seen_at: number;
  storage_used_bytes: number | null;
  storage_quota_bytes: number | null;
  last_sync_at: number | null;
  revoked_at: number | null;
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

/** Phase 4.2: how often to fire `reportClientStats` while the tab is
 *  active. The plan's cadence is 5 min; that matches Anthropic's
 *  prompt-cache TTL and is a reasonable interval to land a fresh
 *  storage estimate (the value changes slowly — kvStore growth from
 *  the Zero replica is on the order of bytes-per-minute under
 *  normal usage). Override via env for tests / soak runs. */
const STATS_REPORT_INTERVAL_MS = (() => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const raw = env?.PUBLIC_FRIDAY_STATS_REPORT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
})();

/** Plan §40 client retention bound for `blocks`. The Zero queries
 *  filter `where("ts", ">", now - BLOCKS_RETENTION_MS)` on both the
 *  foreground per-agent view and the background all-agent prime so
 *  the IndexedDB replica stays bounded. Server keeps everything
 *  (ADR-023 "preserve over delete"); blocks older than this stay
 *  reachable via the jump-to-message search path. */
const BLOCKS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

class ZeroSyncStore {
  /** Live agent rows from Zero, filtered server-side to non-archived. */
  agents = $state<ZeroAgentRow[]>([]);

  /** Live ticket rows from Zero (Phase 3.1). */
  tickets = $state<ZeroTicketRow[]>([]);

  /** Live ticket comments (Phase 3.1 follow-up — reactive read path
   *  for the detail page's comment thread). Filter client-side by
   *  `ticket_id` in the page component. */
  ticketComments = $state<ZeroTicketCommentRow[]>([]);

  /** Live ticket external links (Phase 3.1 follow-up — reactive read
   *  path for the detail page's link list). */
  ticketExternalLinks = $state<ZeroTicketExternalLinkRow[]>([]);

  /** Live evolve proposals (item #54). Replaces the REST poll on the
   *  /evolve dashboard page. Daemon-side projector keeps the
   *  filesystem (canonical) in sync with the Postgres row Zero
   *  replicates from. */
  evolveProposals = $state<ZeroEvolveProposalRow[]>([]);

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

  /** Live client_devices rows from Zero (Phase 4.2). Powers the
   *  Settings → Devices panel (Phase 6) — the "Forget this device"
   *  button calls the `forgetDevice` mutator with the row's
   *  device_id. */
  clientDevices = $state<ZeroClientDeviceRow[]>([]);

  /** Live settings singleton row from Zero (Phase 4.3). Always
   *  length 0 or 1 — the singleton-keyed table guarantees that. The
   *  Settings page derives current model + watchdog values from
   *  here so cross-tab updates land in <1s. */
  settings = $state<ZeroSettingsRow[]>([]);

  /** Live blocks rows for the currently-focused agent (Phase 3.7).
   *  Bound dynamically by {@linkcode bindBlocksFor}; empty when no agent
   *  is focused or when {@linkcode unbindBlocks} has been called. */
  blocks = $state<ZeroBlocksRow[]>([]);

  /** Which agent's blocks the current {@linkcode blocks} view is bound to,
   *  or `null` when no binding is active. The chat store inspects this
   *  to decide whether a focus-switch needs to rebind. */
  blocksAgent = $state<string | null>(null);

  /** Zero's materialization status for the focused-agent blocks query.
   *  `'unknown'` while the local replica may still be backfilling from
   *  the server; `'complete'` once Zero confirms the local set matches
   *  the upstream filter (plan §39 phase 2 completion signal). The
   *  chat store reads this to decide when "you've reached the oldest"
   *  is honest vs. provisional. */
  blocksResultType = $state<"complete" | "unknown" | "error">("unknown");

  /** Connection status of the underlying Zero client. `pending` until
   *  the first materialization, `live` once a snapshot has been
   *  delivered, `error` when the WS bridge is unhealthy. */
  status = $state<"pending" | "live" | "error">("pending");

  /** Phase 6: device id this tab is connected as. Set once `/api/sync/refresh`
   *  resolves; null before then. Read by the Settings → Devices panel to
   *  decide which row is "this device" and by the dashboard card on `/`. */
  get currentDeviceId(): string | null {
    return this.#deviceId;
  }

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
  #blocksListeners = new Set<
    (rows: ZeroBlocksRow[], resultType: "complete" | "unknown" | "error") => void
  >();
  /**
   * Phase 4.2: telemetry-loop handle. `setInterval` token returned by
   * `#init` after `#zero` is constructed; cleared in `destroy()`.
   * Holds the 5-min `reportClientStats` cadence — kept on the
   * instance (not module-level) so `destroy()` can stop it without
   * leaking timers across page navigations.
   */
  #statsInterval: ReturnType<typeof setInterval> | null = null;

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
      // `createMutators()` becomes callable on `this.#zero!.mutate`.
      // The mutator runs once optimistically on the client + once
      // canonically on the server (dashboard's `/api/mutators` push
      // handler routes the server-side execution).
      // `kvStore: "idb"` persists Zero's local replica to IndexedDB
      // across reloads. This is the load-bearing line for the
      // local-first promise (ADR-023, plan §39 two-phase bootstrap):
      // without it, every page load re-syncs from the network, the
      // app refuses to boot offline, and "all access looks local"
      // is a lie. Schema-version changes invalidate the cache
      // automatically (Zero handles that on its own); tab leader
      // election dedupes the write side across multiple tabs.
      this.#zero = new Zero<Schema, Mutators>({
        schema,
        mutators: createMutators(),
        server: zeroServerUrl(),
        auth: token,
        userID: userId,
        kvStore: "idb",
      });

      this.#bindAgents();
      this.#bindTickets();
      this.#bindTicketComments();
      this.#bindTicketExternalLinks();
      this.#bindEvolveProposals();
      this.#bindSchedules();
      this.#bindMemory();
      this.#bindApps();
      this.#bindReadCursors();
      this.#bindClientDevices();
      this.#bindSettings();
      // Plan §39 phase 2: background-sync the 90-day blocks window
      // across every agent so a focus switch is served entirely from
      // the local IndexedDB replica. Fires after the foreground
      // slices so the user-visible first-paint isn't gated on this.
      this.#bindAllBlocksBackground();
      this.status = "live";
      // Phase 4.2: report storage stats immediately on connect +
      // every 5 minutes thereafter. The `client_devices` row already
      // exists (created by `/api/sync/refresh` before this point);
      // the mutator only touches the storage + last-seen fields.
      void this.#reportClientStats();
      this.#statsInterval = setInterval(
        () => void this.#reportClientStats(),
        STATS_REPORT_INTERVAL_MS,
      );
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

      console.error("[zeroSync] init failed:", err);
      // Report to the server-side diagnostic endpoint so a watcher on
      // `friday logs dashboard -f` can see what crashed on a phone /
      // PWA where the user can't open DevTools. Best-effort — a
      // failure here is silent (we're already in the error path).
      void fetch("/api/_diag/client-error", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "zero.init.failed",
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          url: typeof window !== "undefined" ? window.location.href : null,
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
        }),
      }).catch(() => {
        /* best-effort — we're already in the error path */
      });
    }
  }

  #bindAgents(): void {
    if (!this.#zero) return;
    // `enableLegacyQueries: true` in the shared sync schema gives us
    // the connection-bound `z.query.<table>` field; the alternative
    // `createBuilder(schema)` path returns unbound builders that
    // register 0 desired queries with zero-cache.
    //
    // No status filter here: the Sidebar's "Show archived" / "Show
    // inactive" toggles are client-side gates over the full agent
    // list. Filtering archived rows at the query level (prior bug)
    // meant the toggle had nothing to reveal — archived rows never
    // reached the client at all, and the Settings page's per-app
    // agent list silently lost archived entries too.
    const query = this.#zero!.query.agents;
    const preload = this.#zero!.preload(query);
    const view = this.#zero!.materialize(query);
    const update = (data: readonly unknown[]): void => {
      const rows = data as readonly ZeroAgentRow[];
      this.agents = rows as ZeroAgentRow[];
      // Mirror into chat.agents (existing AgentInfo shape) so the
      // existing Sidebar component renders Zero data without code
      // changes — the sidebar's REST poll is gated behind the same
      // feature flag and is skipped when Zero is active.
      chat.agents = rows.map(toAgentInfo);
      // Phase 5b retirement of the `agent_status` SSE event made
      // `agents.status` the canonical "is this agent working" signal.
      // The reconciler heals stale running/streaming bubbles whenever
      // the focused agent's row arrives in a non-'working' state —
      // wedges from lost tool_result rows or evicted per-turn replay
      // buffers converge to terminal here.
      chat.reconcileAgentStatuses(rows);
      // Re-fire applyZeroBlocks for the focused agent whenever the
      // agents snapshot updates. The blocks slice and the agents slice
      // materialize independently — on a cold reload the blocks
      // listener can deliver rows before the agents query has
      // replicated, in which case applyZeroBlocks early-returns
      // (`!chat.agents.some(a => a.name === forAgent)`) and leaves the
      // skeleton up. This call drains that gate the moment the agent
      // row lands: chat.agents now has the focused agent, so the
      // session filter can scope the existing blocks snapshot
      // correctly. Also catches the post-`/clear` agents.session_id =
      // null update — chat.messages flips from the (already-emptied)
      // prior session to filtered-empty without waiting for the next
      // blocks event.
      if (this.blocksAgent !== null && this.blocksAgent === chat.focusedAgent) {
        chat.applyZeroBlocks(this.blocks, this.blocksAgent, this.blocksResultType);
      }
      // Explicit wake-lock reconcile. The wake-lock module's $effect
      // tracks `chat.agents` reads in theory, but cross-context
      // propagation from a Zero listener callback is unreliable in
      // practice — the lock silently never acquires on a phone with
      // the setting on. Firing reconcile directly removes the
      // dependency on Svelte's auto-propagation through this seam.
      reconcileWakeLock();
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
    const query = this.#zero!.query.tickets;
    const preload = this.#zero!.preload(query);
    const view = this.#zero!.materialize(query);
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

  /**
   * Phase 3.1 follow-up: reactive ticket_comments + ticket_external_links
   * reads. The Phase 4.4 mutator work added these tables to the Zero
   * schema with `select: ANYONE_CAN` permissions but never wired the
   * read path — the /tickets/[id] detail page still loaded comments
   * via SSR REST + invalidateAll(). This bind makes mutations in
   * another tab arrive in <1s reactively.
   */
  #bindTicketComments(): void {
    if (!this.#zero) return;
    const query = this.#zero!.query.ticket_comments;
    const preload = this.#zero!.preload(query);
    const view = this.#zero!.materialize(query);
    const update = (data: readonly unknown[]): void => {
      this.ticketComments = data as ZeroTicketCommentRow[];
    };
    update(view.data as readonly unknown[]);
    view.addListener((data) => update(data as readonly unknown[]));
    this.#unsubscribers.push(() => {
      preload.cleanup();
      view.destroy();
    });
  }

  #bindTicketExternalLinks(): void {
    if (!this.#zero) return;
    const query = this.#zero!.query.ticket_external_links;
    const preload = this.#zero!.preload(query);
    const view = this.#zero!.materialize(query);
    const update = (data: readonly unknown[]): void => {
      this.ticketExternalLinks = data as ZeroTicketExternalLinkRow[];
    };
    update(view.data as readonly unknown[]);
    view.addListener((data) => update(data as readonly unknown[]));
    this.#unsubscribers.push(() => {
      preload.cleanup();
      view.destroy();
    });
  }

  #bindEvolveProposals(): void {
    if (!this.#zero) return;
    // Filter out the legacy `rejected`/`dismissed` tombstones from
    // the foreground list — the /evolve UI shows open + applied +
    // critical by default. (No client-side filter equivalent in
    // ZQL: the dashboard's filter chip does the final filter UI-side.)
    const query = this.#zero!.query.evolve_proposals.orderBy("updated_at", "desc");
    const preload = this.#zero!.preload(query);
    const view = this.#zero!.materialize(query);
    const update = (data: readonly unknown[]): void => {
      this.evolveProposals = data as ZeroEvolveProposalRow[];
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
    // Phase 4.6: filter `deleted` tombstones server-side.
    // dashboards see the schedule disappear immediately on user
    // delete (the mutator sets status='deleted' as a soft-delete).
    const query = this.#zero!.query.schedules.where("status", "!=", "deleted");
    const preload = this.#zero!.preload(query);
    const view = this.#zero!.materialize(query);
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
    // Phase 4.5: filter both `deleted` (tombstoned) and
    // `pending_delete` (soft-delete just landed; daemon is moving
    // the file to trash). The dashboard list disappears the entry
    // immediately after the delete mutator fires — the daemon's
    // subsequent flip to `deleted` is invisible to the read path.
    const query = this.#zero!.query.memory_entries.where("status", "!=", "deleted").where(
      "status",
      "!=",
      "pending_delete",
    );
    const preload = this.#zero!.preload(query);
    const view = this.#zero!.materialize(query);
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
    // Phase 4.7: filter `pending_install` server-side. The
    // `installApp` mutator INSERTs a stub row with placeholder
    // name/version/manifest that the daemon overwrites within
    // milliseconds. Filtering keeps the placeholder out of the
    // settings page's apps list until the daemon flips status
    // to 'installed'.
    const query = this.#zero!.query.apps.where("status", "!=", "pending_install");
    const preload = this.#zero!.preload(query);
    const view = this.#zero!.materialize(query);
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
    const query = this.#zero!.query.read_cursors;
    const preload = this.#zero!.preload(query);
    const view = this.#zero!.materialize(query);
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

  #bindClientDevices(): void {
    if (!this.#zero) return;
    // Global query — Friday is single-user, the row set is at most
    // a handful of devices. The Settings → Devices panel reads from
    // this directly.
    const query = this.#zero!.query.client_devices;
    const preload = this.#zero!.preload(query);
    const view = this.#zero!.materialize(query);
    const update = (data: readonly unknown[]): void => {
      const rows = data as readonly ZeroClientDeviceRow[];
      this.clientDevices = rows as ZeroClientDeviceRow[];
    };
    update(view.data as readonly unknown[]);
    view.addListener((data) => update(data as readonly unknown[]));
    this.#unsubscribers.push(() => {
      preload.cleanup();
      view.destroy();
    });
  }

  #bindSettings(): void {
    if (!this.#zero) return;
    // Singleton query. The migration's seed insert + `id = 'singleton'`
    // PK means the row set is guaranteed length 1.
    const query = this.#zero!.query.settings;
    const preload = this.#zero!.preload(query);
    const view = this.#zero!.materialize(query);
    const update = (data: readonly unknown[]): void => {
      const rows = data as readonly ZeroSettingsRow[];
      this.settings = rows as ZeroSettingsRow[];
    };
    update(view.data as readonly unknown[]);
    view.addListener((data) => update(data as readonly unknown[]));
    this.#unsubscribers.push(() => {
      preload.cleanup();
      view.destroy();
    });
  }

  /**
   * Phase 4.2: read `navigator.storage.estimate()` and fire the
   * `reportClientStats` mutator. Silently no-ops when:
   *   - The browser doesn't expose `navigator.storage.estimate()`
   *     (older Safari, some embedded WebViews) — there's nothing to
   *     report; the row's last_seen_at still advances on every JWT
   *     refresh, which is the more important signal.
   *   - Zero or the deviceId aren't initialized yet (the interval
   *     timer can outlive `destroy()` by one tick on page navigate).
   */
  async #reportClientStats(): Promise<void> {
    if (!this.#zero || !this.#deviceId) return;
    let used: number | undefined;
    let quota: number | undefined;
    const storage = (navigator as Navigator & { storage?: StorageManager }).storage;
    if (storage?.estimate) {
      try {
        const est = await storage.estimate();
        used = est.usage;
        quota = est.quota;
      } catch {
        // Cross-origin iframes can fail this with SecurityError;
        // treat as "no data" rather than throwing.
      }
    }
    // Bail again — the estimate await may have racey-resolved after
    // a destroy().
    if (!this.#zero || !this.#deviceId) return;
    const result = this.#zero!.mutate.reportClientStats({
      deviceId: this.#deviceId,
      storageUsedBytes: used,
      storageQuotaBytes: quota,
      ts: Date.now(),
    });
    // Background hygiene — debug-level only. Failures are recoverable
    // (next interval re-tries) and not user-visible.
    void awaitMutatorServer(result).then((outcome) => {
      if (typeof outcome === "object" && outcome.kind !== "success") {
        console.debug(`reportClientStats mutator error: ${outcome.message}`);
      }
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
   * Local-first contract (plan §39, §40): syncs the entire 90-day
   * retention window for the focused agent into IndexedDB. No row
   * limit, no REST scroll-back — the local replica IS the source of
   * truth the UI reads from. The 90-day bound caps client storage
   * (server keeps everything per ADR-023); blocks older than that
   * are reachable only via the "lazy on demand" jump-to-message
   * search path (kept on REST for now since it crosses retention).
   *
   * Background sync of OTHER agents is primed by
   * {@link #bindAllBlocksBackground} at init time so a focus switch
   * to a previously-untouched agent finds its rows already local.
   */
  bindBlocksFor(agentName: string): void {
    if (!this.#zero) {
      // Defer: `#init` is still in flight. The last write wins so a
      // rapid focus-switch (A → B → C before init resolves) ends up
      // bound to C, which matches what the user would expect.
      this.#pendingBlocksAgent = agentName;
      return;
    }
    if (this.blocksAgent === agentName && this.#blocksTeardown) {
      // Same-agent rebind: don't tear down + re-materialize the view (that
      // would burn a zero-cache round-trip and flash the data). But DO
      // re-fire the listener set with the current snapshot, because callers
      // use this method as a "you have the current data" signal — past-
      // session → live navigation re-enters loadAgentTurns, which sets
      // `loadingInitial=true` and then calls this binder expecting the
      // listener to flip it back off via applyZeroBlocks. Without this
      // synthetic frame, the chat sits at a stuck skeleton until the next
      // upstream delta lands (which, on a quiet agent, may be never).
      for (const listener of this.#blocksListeners) {
        listener(this.blocks, this.blocksResultType);
      }
      return;
    }
    this.unbindBlocks();
    this.blocksAgent = agentName;
    const cutoff = Date.now() - BLOCKS_RETENTION_MS;
    const query = this.#zero!.query.blocks.where("agent_name", "=", agentName)
      .where("status", "!=", "streaming")
      .where("status", "!=", "cancel_requested")
      .where("ts", ">", cutoff)
      .orderBy("ts", "desc");
    const preload = this.#zero!.preload(query);
    const view = this.#zero!.materialize(query);
    const update = (
      data: readonly unknown[],
      resultType: "complete" | "unknown" | "error",
    ): void => {
      const rows = data as readonly ZeroBlocksRow[];
      this.blocks = rows as ZeroBlocksRow[];
      this.blocksResultType = resultType;
      for (const listener of this.#blocksListeners) listener(this.blocks, resultType);
    };
    update(view.data as readonly unknown[], "unknown");
    view.addListener((data, resultType) => update(data as readonly unknown[], resultType));
    this.#blocksTeardown = (): void => {
      preload.cleanup();
      view.destroy();
    };
  }

  /**
   * Plan §39 phase 2 ("background full active state"): after the
   * foreground per-agent query for the focused agent is bound, prime
   * the local replica with the 90-day window across *all* agents so
   * focus switches don't pay network cost. Preloads only — no JS
   * materialization (we don't need every agent's blocks in memory).
   * Runs once per `#init` and is torn down with the other slices.
   */
  #bindAllBlocksBackground(): void {
    if (!this.#zero) return;
    const cutoff = Date.now() - BLOCKS_RETENTION_MS;
    const query = this.#zero!.query.blocks.where("status", "!=", "streaming")
      .where("status", "!=", "cancel_requested")
      .where("ts", ">", cutoff);
    // `ttl` here only matters AFTER `handle.cleanup()` fires — while
    // the handle is alive (i.e. for the life of this dashboard tab),
    // the preloaded rows stay in the replica. Zero 1.5 hard-caps the
    // ttl at 10 minutes (`MAX_TTL_MS` in `@rocicorp/zero/out/zql/src/query/ttl.js`)
    // and emits a `QueryManager: TTL (Xd) is too high, clamping to 10m`
    // warning on every page load for any value higher. 10m matches
    // the cap and silences the warning; the practical effect is
    // identical because we hold the handle for the tab's lifetime.
    const handle = this.#zero!.preload(query, { ttl: "10m" });
    this.#unsubscribers.push(() => handle.cleanup());
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
   *  initial frame. The `resultType` argument forwards Zero's
   *  materialization status (`'complete'` once the local replica
   *  matches the upstream filter — used by the chat store to decide
   *  when "no more older messages" is honest). */
  onBlocksUpdate(
    listener: (rows: ZeroBlocksRow[], resultType: "complete" | "unknown" | "error") => void,
  ): () => void {
    this.#blocksListeners.add(listener);
    listener(this.blocks, this.blocksResultType);
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
    const result = this.#zero!.mutate.markRead({
      deviceId: this.#deviceId,
      agentName,
      lastSeenBlockId: blockId,
      ts: Date.now(),
    });
    // Background hygiene — debug-level only. Failure is self-correcting
    // (next focus event re-issues the mutator with a fresh cursor).
    void awaitMutatorServer(result).then((outcome) => {
      if (typeof outcome === "object" && outcome.kind !== "success") {
        console.debug(`markRead mutator error: ${outcome.message}`);
      }
    });
  }

  /**
   * Plan §41: trigger the `forgetDevice` mutator. Sets `revoked_at`
   * on the matching `client_devices` row so the daemon's
   * `/api/sync/refresh` deny-list lookup refuses to mint another JWT
   * for that device_id. The prior hard-DELETE behavior was cosmetic
   * — the next refresh just re-upserted the row.
   *
   * Recovery: the user clears the `friday-device-id` cookie (the
   * dashboard does this implicitly when forgetting the CURRENT tab
   * via the sign-out coupling in `settings/+page.svelte`); the next
   * refresh mints a fresh device row under a brand-new UUID.
   */
  forgetDevice(deviceId: string): void {
    if (!this.#zero) return;
    const result = this.#zero!.mutate.forgetDevice({
      deviceId,
      ts: Date.now(),
    });
    // Explicit user action — warn-level so the failure lands in devtools.
    // The settings panel surfaces the failure eyeball-style (the device
    // stays in the list) rather than via a dedicated toast; this ticket
    // only guarantees the error isn't invisible at the log layer.
    void awaitMutatorServer(result).then((outcome) => {
      if (typeof outcome === "object" && outcome.kind !== "success") {
        console.warn(`forgetDevice mutator error: ${outcome.message}`);
      }
    });
  }

  /**
   * Phase 4.3: dispatch the `updateSettings` mutator. Partial — omit
   * fields you don't want to touch. The daemon's LISTEN handler
   * re-syncs `~/.friday/config.json` from the new row contents so
   * the next worker spawn picks up the change without a daemon
   * restart.
   *
   * No-op when Zero hasn't finished init (the Settings page can call
   * this from the input handler without gating on `status === 'live'`).
   */
  updateSettings(args: { model?: string; watchdogRefork?: boolean }): void {
    if (!this.#zero) return;
    const result = this.#zero!.mutate.updateSettings({
      ...args,
      ts: Date.now(),
    });
    // Explicit user action — warn-level so the failure lands in devtools.
    // The reactive `$effect` in the settings panel mirrors canonical
    // values back into inputs ("slider snaps back") if the write failed;
    // the unconditional "saved" toast bug in `settings/+page.svelte` is
    // a separate UX issue and out of scope for FRI-104.
    void awaitMutatorServer(result).then((outcome) => {
      if (typeof outcome === "object" && outcome.kind !== "success") {
        console.warn(`updateSettings mutator error: ${outcome.message}`);
      }
    });
  }

  /**
   * Phase 4.4: ticket mutators. Each wraps the corresponding entry
   * in `createMutators()` with `ts: Date.now()` stamping at the call
   * boundary. All are no-ops if `#zero` isn't bound — callers can
   * dispatch unconditionally.
   *
   * `createTicket` requires a pre-computed `id` (FRI-N) — callers
   * compute it via `nextTicketIdFrom(zeroSync.tickets)` from
   * `@friday/shared/sync`. The local reactive snapshot is the
   * authoritative max; race-loss surfaces as a `MutatorResult` error
   * the dashboard can retry.
   */
  createTicket(args: {
    id: string;
    title: string;
    body?: string;
    status?: "open" | "in_progress" | "done" | "blocked" | "closed";
    kind?: "task" | "epic" | "bug" | "chore";
    assignee?: string;
    meta?: Record<string, unknown>;
  }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.createTicket({ ...args, ts: Date.now() });
  }
  updateTicket(args: {
    id: string;
    title?: string;
    body?: string | null;
    status?: "open" | "in_progress" | "done" | "blocked" | "closed";
    kind?: "task" | "epic" | "bug" | "chore";
    assignee?: string | null;
    meta?: Record<string, unknown> | null;
  }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.updateTicket({ ...args, ts: Date.now() });
  }
  addTicketComment(args: {
    id: string;
    ticketId: string;
    author: string;
    body: string;
  }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.addTicketComment({ ...args, ts: Date.now() });
  }
  addTicketRelation(args: {
    parentId: string;
    childId: string;
    kind: "depends_on" | "child_of" | "blocks" | "relates_to";
  }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.addTicketRelation(args);
  }
  linkTicketExternal(args: {
    ticketId: string;
    system: string;
    externalId: string;
    url?: string;
    meta?: Record<string, unknown>;
  }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.linkTicketExternal({ ...args, ts: Date.now() });
  }
  unlinkTicketExternal(args: {
    ticketId: string;
    system: string;
    externalId: string;
  }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.unlinkTicketExternal(args);
  }

  /**
   * Phase 4.5: memory mutators. Dashboard writes only the Postgres
   * row (status='pending_file' or 'pending_delete'); the daemon's
   * LISTEN handler picks it up, writes/moves the markdown file
   * under `~/.friday/memory/entries/`, and flips status to
   * 'ready' or 'deleted'.
   *
   * `createMemoryEntry` requires a pre-computed `id` from
   * `slugifyMemoryId(title)` (exported from `@friday/shared/sync`).
   */
  createMemoryEntry(args: {
    id: string;
    title: string;
    content: string;
    tags: string[];
    createdBy: string;
  }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.createMemoryEntry({ ...args, ts: Date.now() });
  }
  updateMemoryEntry(args: {
    id: string;
    title?: string;
    content?: string;
    tags?: string[];
  }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.updateMemoryEntry({ ...args, ts: Date.now() });
  }
  deleteMemoryEntry(args: { id: string }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.deleteMemoryEntry({ ...args, ts: Date.now() });
  }

  /**
   * Phase 4.6: schedule mutators. Dashboard writes pending status;
   * daemon's LISTEN handler registers/recomputes/cleans up + flips
   * to terminal status.
   */
  createSchedule(args: {
    name: string;
    cron?: string;
    runAt?: string;
    taskPrompt: string;
    paused?: boolean;
  }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.createSchedule({ ...args, ts: Date.now() });
  }
  updateSchedule(args: {
    name: string;
    cron?: string | null;
    runAt?: string | null;
    taskPrompt?: string;
    paused?: boolean;
  }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.updateSchedule({ ...args, ts: Date.now() });
  }
  deleteSchedule(args: { name: string }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.deleteSchedule({ ...args, ts: Date.now() });
  }
  pauseSchedule(args: { name: string }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.pauseSchedule({ ...args, ts: Date.now() });
  }
  resumeSchedule(args: { name: string }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.resumeSchedule({ ...args, ts: Date.now() });
  }
  triggerSchedule(args: { name: string }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.triggerSchedule({ ...args, ts: Date.now() });
  }

  /**
   * Phase 4.7: app mutators. Dashboard inserts pending-install
   * stub / sets pending status; daemon's LISTEN handler dispatches
   * to the existing `installApp` / `uninstallApp` / `reloadApp`
   * functions in `services/daemon/src/apps/installer.ts`.
   *
   * `installApp` is asymmetric — the daemon owns the manifest (it
   * lives on the daemon's filesystem). The mutator INSERTs a stub
   * row that the daemon overwrites within milliseconds. The
   * dashboard's apps reactive query filters status='pending_install'
   * so the placeholder is never user-visible.
   */
  installApp(args: { id: string; folderPath: string }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.installApp({ ...args, ts: Date.now() });
  }
  uninstallApp(args: { id: string }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.uninstallApp({ ...args, ts: Date.now() });
  }
  reloadApp(args: { id: string }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.reloadApp({ ...args, ts: Date.now() });
  }

  /**
   * Phase 4.8: trigger the archiveAgent flow. Mutator UPDATEs
   * agent row to status='archive_requested' + archive_reason;
   * daemon's LISTEN handler calls the existing lifecycle
   * `archiveAgent(name, {reason})` which kills the worker, archives
   * the worktree, closes linked tickets, and flips status='archived'.
   *
   * `reason` defaults to 'abandoned' to match the legacy `/archive`
   * slash-command default. The reason drives the linked-ticket-
   * close behavior — see `services/daemon/src/services/ticket-close.ts`.
   */
  archiveAgent(args: {
    name: string;
    reason?: "completed" | "abandoned" | "failed";
  }): MutatorResult | undefined {
    if (!this.#zero) return;
    return this.#zero!.mutate.archiveAgent({
      name: args.name,
      reason: args.reason ?? "abandoned",
      ts: Date.now(),
    });
  }

  /**
   * Phase 4.9: cancel a queued user-chat prompt before the worker
   * dispatches it. Three-step flow:
   *
   *   1. Look up the queued block in the local Zero snapshot by
   *      turn_id (the dashboard knows the turn the user wants to
   *      cancel, not the bigserial PK). Bail if we can't find one —
   *      the user clicked Cancel on a bubble that's already
   *      dispatched or already removed.
   *   2. POST the daemon fast-path (`/api/internal/cancel-queued`)
   *      to synchronously splice the worker's in-memory
   *      `nextPrompts` deque. The HTTP response carries back the
   *      recovered prompt text so the caller can stuff it into the
   *      input bar.
   *   3. Dispatch the Zero mutator (UPDATE blocks.status =
   *      'cancel_requested'). This is the durable, cross-device
   *      signal: the Postgres trigger fires NOTIFY, the daemon
   *      LISTEN handler picks it up, calls `removeQueuedPrompt`
   *      (idempotent — already done by step 2), publishes the
   *      `block_meta_update` SSE for legacy tabs, and DELETEs the
   *      row.
   *
   * Both the fast-path and the LISTEN-path are idempotent against
   * each other (plan §5). If step 2 fails (daemon down), we still
   * dispatch the mutator — the row will commit to Postgres via
   * zero-cache's queue, and the LISTEN-path will splice + delete
   * once the daemon returns.
   *
   * Returns the recovered prompt text on success (possibly empty
   * string if the block's content_json couldn't be parsed), or
   * `null` if no matching queued bubble was found.
   */
  /**
   * Phase 4.11b: dispatch a new user-chat turn through the
   * `sendUserMessage` mutator. The caller (sendQueue) pre-mints a
   * UUID at enqueue time and threads it through here as `blockId`
   * — every retry of the same logical send reuses that id so the
   * canonical `blocks.id` PK acts as the natural dedup boundary
   * (FRI-103). The turn id is derived as `t_<blockId>`. The
   * optimistic client write lands the bubble immediately; the
   * canonical server write fires the Postgres trigger; the daemon's
   * LISTEN handler resolves the agent, composes prompt, detects
   * skills, wraps with recall, and dispatches the turn.
   *
   * Returns `{ blockId, turnId }` on success, or `null` if Zero
   * hasn't initialized yet (caller should retry on next flush).
   */
  async sendUserMessage(args: {
    /** Pre-minted by the caller — see FRI-103 invariant in
     *  `send-queue.svelte.ts`. Used as the canonical `blocks.id` PK
     *  AND echoed back to the caller for ack-by-blockId. */
    blockId: string;
    agent: string;
    text: string;
    attachments?: Array<{ sha256: string; filename: string; mime: string }>;
  }): Promise<{ blockId: string; turnId: string } | null> {
    if (!this.#zero) return null;
    const blockId = args.blockId;
    const turnId = `t_${blockId}`;
    const result = this.#zero!.mutate.sendUserMessage({
      id: blockId,
      turnId,
      agentName: args.agent,
      text: args.text,
      attachments: args.attachments,
      ts: Date.now(),
    });
    const outcome = await awaitMutatorServer(result);
    if (outcome === "no-zero") return null;
    if (outcome.kind === "success") return { blockId, turnId };
    if (outcome.kind === "app-error" && outcome.pkCollision) {
      // PK collision on the canonical `blocks.id` is the dedup success
      // path — the original push committed; this retry is idempotent
      // (FRI-103 invariant). Return the success shape so sendQueue
      // clears the entry instead of looping on the same id forever.
      return { blockId, turnId };
    }
    // Genuine app-error (non-PK) OR transport `zero-error`. Returning
    // `null` lets sendQueue's existing retry path (`send-queue.svelte.ts:247-263`)
    // increment `attempts`, set `lastError = "zero_not_ready"`, and
    // surface the failed-row UI via the standard `MAX_ATTEMPTS` fence.
    // The queue entry IS preserved — FRI-103 data-safety invariant.
    return null;
  }

  /**
   * Phase 4.10: abort an in-flight turn. Three-step flow:
   *
   *   1. Look up the user block for this turn in the local Zero
   *      snapshot (need the bigserial id for the mutator). Bail if
   *      no matching block — the turn already finished or never
   *      committed.
   *   2. POST the daemon fast-path (`/api/internal/abort-turn`) to
   *      synchronously fire the worker's AbortController. The
   *      response carries `{aborted: bool}` mirroring the legacy
   *      REST endpoint's shape.
   *   3. Dispatch the Zero mutator (UPDATE blocks.status =
   *      'abort_requested') so the durable + cross-device signal
   *      reaches the daemon's LISTEN handler. The handler calls the
   *      same lifecycle `abortTurn` (idempotent against step 2)
   *      and flips the row back to 'complete'.
   *
   * Both paths are idempotent against each other. If step 2 fails
   * (daemon down), the mutator still commits durably — when the
   * daemon comes back up, the boot-recovery scan picks up the
   * `abort_requested` row and dispatches the lifecycle abort then.
   *
   * Returns `true` if the abort was dispatched, `false` if no
   * matching block was found.
   */
  async abortTurn(turnId: string): Promise<boolean> {
    if (!this.#zero) return false;
    // Fire the daemon fast-path FIRST, unconditionally. The endpoint
    // only needs `turn_id` — it looks up the live worker via the
    // in-memory `findAgentByTurnId` map, not via Zero's materialized
    // blocks window. Prior to this fix we bailed early if no user_chat
    // block was in `this.blocks`, which happens any time the user
    // sends a message that pushes the original user_chat row out of
    // the 50-row ts-desc window (long-running turns with many tool
    // calls) — Stop became silently a no-op, the worker kept
    // chewing, and the dashboard log showed zero `/api/internal/abort-turn`
    // POSTs. The mutator dispatch below still needs the row's PK; if
    // we can't find one we skip just that leg (the fast-path already
    // aborted the worker — the durable signal is for cross-device
    // reconciliation, which a single user with one tab doesn't need).
    let fastPathOk = false;
    try {
      const r = await fetch("/api/internal/abort-turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turn_id: turnId }),
      });
      fastPathOk = r.ok;
    } catch {
      // Daemon unreachable — the mutator (when it dispatches) is the
      // durable backstop. The daemon's LISTEN handler picks up the
      // `abort_requested` row on next boot and aborts then.
    }

    const row = this.blocks.find(
      (b) => b.turn_id === turnId && b.role === "user" && b.source === "user_chat",
    );
    if (row) {
      const result = this.#zero!.mutate.abortTurn({
        id: row.id,
        ts: Date.now(),
      });
      const outcome = await awaitMutatorServer(result);
      if (typeof outcome === "object" && outcome.kind !== "success") {
        // Server-side mutator failure (e.g. row already on 'aborted',
        // or transport-level Zero error). User-visible state is still
        // correct — the fast-path POST already aborted the worker.
        // Log to console for diagnostics; no toast required since the
        // fast-path is the primary lever and Zero's outbox will re-push
        // any transport-level miss.
        console.warn(`abortTurn mutator error: ${outcome.message}`);
      }
    }

    return fastPathOk || row !== undefined;
  }

  async cancelQueued(turnId: string): Promise<string | null> {
    if (!this.#zero) return null;
    const row = this.blocks.find(
      (b) =>
        b.turn_id === turnId &&
        b.role === "user" &&
        b.source === "user_chat" &&
        b.status === "queued",
    );
    if (!row) return null;

    let recoveredText = "";
    try {
      const r = await fetch("/api/internal/cancel-queued", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ block_id: row.block_id }),
      });
      if (r.ok) {
        const data = (await r.json().catch(() => ({}))) as { text?: unknown };
        if (typeof data.text === "string") recoveredText = data.text;
      }
    } catch {
      // Daemon unreachable — fall through to the mutator dispatch.
      // The mutator's row UPDATE replicates durably; the daemon's
      // LISTEN-path picks it up once it returns. Recovered text
      // falls back to the local Zero snapshot's content_json below.
    }

    // Fallback recovery from the local snapshot if the fast-path
    // failed or returned an empty text. The Zero row's content_json
    // is the same JSON the daemon serialized into the DB.
    if (!recoveredText) {
      const parsed = row.content_json as { text?: unknown } | null;
      if (parsed && typeof parsed.text === "string") recoveredText = parsed.text;
    }

    const cancelResult = this.#zero!.mutate.cancelQueued({
      id: row.id,
      ts: Date.now(),
    });
    const outcome = await awaitMutatorServer(cancelResult);
    if (typeof outcome === "object" && outcome.kind !== "success") {
      // Server-side mutator failure (e.g. row already DELETEd by the
      // LISTEN-path winning the race) or transport-level Zero error.
      // User-visible state is already correct — the bubble is gone and
      // the prompt text is recovered. Log to console for diagnostics.
      console.warn(`cancelQueued mutator error: ${outcome.message}`);
    }

    return recoveredText;
  }

  destroy(): void {
    if (this.#statsInterval) {
      clearInterval(this.#statsInterval);
      this.#statsInterval = null;
    }
    for (const unsub of this.#unsubscribers) unsub();
    this.#unsubscribers = [];
    this.unbindBlocks();
    this.#blocksListeners.clear();
    void this.#zero?.close();
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
    sessionCount: r.session_count,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function zeroServerUrl(): string {
  // Zero 1.5 expects an http(s) URL (the protocol upgrades to WS during
  // handshake); passing `ws://` throws `must use the "http" or "https"
  // scheme.` Zero's createConnectionURL then appends `/sync/v50/connect`
  // to whatever we return here.
  const env = (
    import.meta as unknown as {
      env?: Record<string, string | undefined> & { DEV?: boolean; PROD?: boolean };
    }
  ).env;
  // Explicit override always wins (CI, integration tests, future
  // deploy topologies).
  if (env?.PUBLIC_FRIDAY_ZERO_URL) return env.PUBLIC_FRIDAY_ZERO_URL;
  // Prod build: route through the dashboard's own origin via the
  // server-entry WS reverse-proxy at `/zero` (server-entry.mjs).
  // This is what lets a phone over Cloudflare Tunnel reach zero-cache
  // — the local 4848 listener is unreachable from outside the host.
  // The mount path is single-segment because `ZeroOptions.server` is
  // validated by Zero to have at most one path component; `/api/sync`
  // is rejected at construction time. Use `window.location.origin` so
  // the same bundle works against any hostname (localhost,
  // friday.voltzmakes.com, an alt CF tunnel, etc.) without rebuilding.
  if (env?.PROD && typeof window !== "undefined") {
    return `${window.location.origin}/zero`;
  }
  // Dev (`vite dev`): connect directly to the local zero-cache.
  // vite dev doesn't run the server-entry proxy, and dev only ever
  // serves clients on the same host anyway.
  return "http://localhost:4848";
}

/**
 * Whether to bring up the Zero client in the current execution context.
 *
 * Always `true` in a browser: Phase 5 retired the SSE/REST fallback
 * paths for every slice Zero replaces (agents, tickets, schedules,
 * memory, mail, blocks, apps, read-cursors, client-devices, settings),
 * so there is no longer a coherent "Zero off" mode — the rest of the
 * dashboard expects the Zero materializations to be live. The
 * `PUBLIC_FRIDAY_USE_ZERO` / `friday:flag:use-zero` opt-ins from
 * Phase 2's gradual rollout are gone with the fallback paths they
 * gated.
 *
 * Always `false` during SSR: Zero owns a WS connection and an in-memory
 * cache that only make sense on the client. Server-side renders use
 * REST data from `+page.server.ts` load functions and hydrate into
 * Zero on the client.
 */
export function useZero(): boolean {
  return browser;
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
// init.
//
// The wiring is deferred via `queueMicrotask` because Rollup may chunk
// the two stores so that this module-top-level block runs BEFORE
// `chat.svelte.ts`'s `export const chat = new ChatState()` assignment
// has executed (the `var c_ = new class …` declaration ends up after
// the use site in the merged chunk, leaving `chat` hoisted as
// `undefined`). Under the previous Phase 2 feature-flag default of
// `useZero() === false` the IF never fired and this latent ordering
// bug stayed hidden; collapsing the flag to "always on in browser"
// exposed it as a `TypeError: Cannot read properties of undefined
// (reading 'setBlocksBinder')` on every cold page load. A microtask
// boundary lets module evaluation finish first.
if (browser) {
  queueMicrotask(() => {
    chat.setBlocksBinder((agent: string | null) => {
      if (agent) zeroSync.bindBlocksFor(agent);
      else zeroSync.unbindBlocks();
    });
    zeroSync.onBlocksUpdate((rows, resultType) => {
      const agent = zeroSync.blocksAgent;
      if (!agent) return;
      chat.applyZeroBlocks(rows, agent, resultType);
    });
    // Phase 4.1: register the markRead callback. Chat calls this from
    // `applyZeroBlocks` after each per-agent snapshot to advance the
    // read cursor to the newest block. Same circular-dep avoidance
    // pattern as the binder: chat doesn't import zero.
    chat.setMarkReadFn((agent, blockId) => zeroSync.markRead(agent, blockId));
    chat.setSendMessageFn((args) => zeroSync.sendUserMessage(args));
  });

  // Global error/rejection reporters — when a PWA on a phone can't
  // open DevTools, the only surface that tells us what's blowing up
  // is the server log. Forward every uncaught error + unhandled
  // promise rejection to `/api/_diag/client-error` so a watcher on
  // `friday logs dashboard -f` sees them.
  const reportToServer = (event: string, message: string, stack?: string) => {
    void fetch("/api/_diag/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event,
        message,
        stack,
        url: window.location.href,
        userAgent: navigator.userAgent,
      }),
    }).catch(() => {
      /* best-effort */
    });
  };
  window.addEventListener("error", (e) => {
    reportToServer("window.error", e.message, e.error?.stack);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    reportToServer("window.unhandledrejection", msg, stack);
  });
}

// Dev probe: expose the singleton on `window` so devtools and Playwright
// probes can read its state without having to re-import the module
// (Vite gives each import path its own instance, defeating in-page
// inspection). Removed in Phase 6 when the connectivity widget surfaces
// the same signals natively.
if (browser) {
  (globalThis as unknown as { __fridayZero?: ZeroSyncStore }).__fridayZero = zeroSync;
}

/**
 * @deprecated Use {@linkcode zeroSync}. Same singleton; the Phase 2
 * name is preserved for backward compat with the Sidebar component.
 */
export const zeroSidebar = zeroSync;
