import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { logger } from "../log.js";
import { eventBus, getBootId, getBootTs } from "../events/bus.js";
import {
  cancel as cancelElicitation,
  register as registerElicitation,
  resolve as resolveElicitation,
  type ElicitationAnswer,
} from "../elicitation/registry.js";
import {
  type AgentEntry,
  DAEMON_SECRET_HEADER,
  getDaemonSecret,
  isLocalHost,
  loadConfig,
  isSecretsLocked,
  loadFridayConfig,
  resolveDaemonPort,
  resolveModelForRole,
} from "@friday/shared";
import {
  addComment,
  closeMail,
  consumeRateLimit,
  createTicket,
  externalLinks,
  fetchBlocksByAgent,
  getAttachment,
  getMail,
  getTicket,
  inbox,
  linkExternal,
  unlinkExternal,
  listAgentSessions,
  listComments,
  listTickets,
  markRead,
  readAttachmentBytes,
  searchMail,
  sendMail,
  sessionCountsByAgent,
  updateTicket,
  uploadAttachment,
} from "@friday/shared/services";
import {
  forgetEntry,
  getEntry,
  listEntries,
  saveEntry,
  searchMemories,
  touchRecall,
  updateEntry,
  type MemoryEntry,
} from "@friday/memory";
import { runHooks } from "@friday/shared";
import { buildDispatchPrompt } from "../prompts/build-dispatch-prompt.js";
import { buildSystemPrompt } from "../prompts/build-system-prompt.js";
import { resolveRecipient, validateRecipient } from "../comms/recipient.js";
import {
  DEFAULT_RULE,
  deleteProposal,
  enrichProposals,
  getProposal,
  listProposals,
  mergeClusters,
  proposeFromSignals,
  rerankAll,
  saveProposal,
  scanAll,
  scanFriction,
  scanPreferences,
  sinceHoursAgo,
  appendRun,
  triageSpawnPlan,
  builderEscalationPlan,
  updateProposal,
  type Proposal,
  type SaveProposalInput,
  type UpdateProposalInput,
} from "@friday/evolve";
import { deleteProposalFromPg, syncProposalToPg } from "../evolve/projector.js";
import { syncProposalsForClosedTickets } from "../services/proposal-sync.js";
import {
  createIssueWithConfiguredTeam as linearCreateIssue,
  getStateIdByType as linearGetStateIdByType,
  importIssue as linearImportIssue,
  LinearApiError,
  reconcile as linearReconcile,
  resolveIssueIdByIdentifier as linearResolveIssueIdByIdentifier,
  updateIssue as linearUpdateIssue,
  type LinearPriority,
  type LinearStateType,
  type UpdateIssueInput,
} from "@friday/integrations-linear";
import {
  deleteSchedule,
  getSchedule,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  ScheduleNameCollisionError,
  triggerSchedule,
  upsertSchedule,
} from "../scheduler/scheduler.js";
import { readScheduleArtifacts } from "../scheduler/state.js";
import * as registry from "../agent/registry.js";
import {
  computeSpawnDepth,
  validateSpawnPermissions,
  type CallerType,
} from "../agent/spawn-permissions.js";
import {
  abortTurn,
  archiveAgent,
  dispatchTurn,
  findAgentByTurnId,
  forceWorkerRefork,
  peekLiveWorker,
  removeQueuedPrompt,
  stopWorkersForApp,
} from "../agent/lifecycle.js";
import { recordUserBlock } from "../agent/block-injectors.js";
import { getBlockById } from "@friday/shared/services";
import { generateScratchName } from "../agent/scratch-names.js";
import { archiveWorkspace, createWorkspace, workspacePath } from "../agent/workspace.js";
import { commandsApi } from "./commands.js";
import {
  AppInstallError,
  installApp,
  inspectApp,
  listApps,
  reloadApp,
  uninstallApp,
} from "../apps/installer.js";
import { randomUUID } from "node:crypto";
import { isValidAgentName } from "@friday/shared";
import type { AgentType } from "@friday/shared";

const DAEMON_VERSION = (JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")
) as { version: string }).version;

export interface StartServerOptions {
  port: number;
}

export function startServer(opts: StartServerOptions) {
  const cfg = loadConfig();
  const server = createServer((req, res) => handle(req, res, cfg));
  server.listen(opts.port, "127.0.0.1");
  logger.log("info", "api.listening", { port: opts.port });
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ReturnType<typeof loadConfig>,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  res.setHeader("X-Friday-Version", DAEMON_VERSION);

  // --- Health ---
  if (method === "GET" && path === "/api/health") {
    // FIX_FORWARD 5.8: gate /api/health behind the same-host secret so a
    // local web page (or a DNS-rebind attacker) can't probe daemon status
    // without first reading ~/.friday/.daemon-secret.
    if (!authorizeSameHost(req)) {
      return json(res, 401, { error: "unauthorized" });
    }
    return json(res, 200, {
      ok: true,
      ts: Date.now(),
      secretsLocked: isSecretsLocked(),
    });
  }

  if (method === "POST" && path === "/api/secrets/reload") {
    if (!authorizeSameHost(req)) {
      return json(res, 401, { error: "unauthorized" });
    }
    const { clearFridayConfigCache, clearSecretsCache, unlockVault } =
      await import("@friday/shared");
    clearSecretsCache();
    clearFridayConfigCache();
    const result = await unlockVault(true);
    return json(res, 200, { ok: result.ok, reason: result.ok ? undefined : result.reason });
  }

  if (method === "POST" && path === "/api/secrets/audit") {
    if (!authorizeSameHost(req)) {
      return json(res, 401, { error: "unauthorized" });
    }
    const body = await readJson<{
      secretName: string;
      callerName: string;
      callerType: string;
      appId?: string | null;
      reason: string;
      source: "mcp" | "cli";
    }>(req);
    const { logSecretsFetch } = await import("../services/secrets-audit.js");
    const logged = await logSecretsFetch(body);
    if (!logged.ok) return json(res, 429, { error: logged.error });
    return json(res, 200, { ok: true });
  }

  // --- Commands (system + skills, for chat autocomplete) ---
  if (method === "GET" && path === "/api/commands") {
    return json(res, 200, commandsApi());
  }

  // --- System command dispatch ---
  if (method === "POST" && path === "/api/commands/dispatch") {
    const body = await readJson<{ command: string; args?: string }>(req);
    return await handleSystemCommand(res, body, cfg);
  }

  // --- SSE events ---
  if (method === "GET" && path === "/api/events") {
    return handleEvents(req, res, cfg);
  }

  // --- FRI-152 elicitation bridge ---
  // The worker's `mcp__friday-elicitation__ask_user` handler calls:
  //   1. POST /api/elicitation/wait { agentName, turnId, toolUseId }
  //      — atomically register a waiter + emit SSE + block until answer.
  // The dashboard's panel submit calls:
  //   2. POST /api/elicitation/<id>/submit  — supply the answer.
  // Together these implement the turn-pause property: the SDK is blocked
  // inside the MCP handler's `await` for (1)'s response, which only
  // returns after (2) fires the in-memory resolver.
  if (method === "POST" && path === "/api/elicitation/wait") {
    const body = await readJson<{
      agentName?: string;
      turnId?: string;
      toolUseId?: string;
    }>(req);
    if (
      typeof body.agentName !== "string" ||
      typeof body.turnId !== "string" ||
      typeof body.toolUseId !== "string" ||
      body.toolUseId.length === 0
    ) {
      return json(res, 400, { error: "missing_fields" });
    }
    const promise = registerElicitation(body.toolUseId);
    // Fire SSE AFTER registering the waiter so the dashboard's submit
    // can't beat us to the resolver. (The submit handler returns 409
    // if no waiter is registered; that would deadlock a fast user.)
    eventBus.publish({
      v: 1,
      type: "elicitation_requested",
      agent: body.agentName,
      turn_id: body.turnId,
      tool_use_id: body.toolUseId,
      ts: Date.now(),
    });
    const onAbort = () => {
      cancelElicitation(body.toolUseId!, new Error("client_aborted"));
    };
    req.on("close", onAbort);
    try {
      const answer = await promise;
      req.off("close", onAbort);
      return json(res, 200, answer);
    } catch (err) {
      req.off("close", onAbort);
      return json(res, 499, { error: String((err as Error).message) });
    }
  }
  if (method === "POST" && path.startsWith("/api/elicitation/") && path.endsWith("/submit")) {
    const id = path.slice("/api/elicitation/".length, -"/submit".length);
    if (id.length === 0) return json(res, 400, { error: "missing_id" });
    const body = await readJson<ElicitationAnswer>(req);
    if (!body || typeof body !== "object" || !body.answers) {
      return json(res, 400, { error: "missing_answers" });
    }
    const resolved = resolveElicitation(id, body);
    if (!resolved) return json(res, 409, { error: "no_waiter", id });
    return json(res, 200, { ok: true });
  }

  // --- Chat turn (FRI-123 — all ADR-024 retired routes deleted) ---
  // The legacy `POST /api/chat/turn`, `DELETE .../<id>/queued`,
  // `POST .../<id>/abort`, and `POST .../<id>/resume` REST routes
  // (ADR-024 retirement set) all retired in this PR. Live paths:
  //   - send: `sendUserMessage` Zero mutator → dispatch-listener.
  //   - cancel queued: `cancelQueued` Zero mutator → cancel-listener
  //     + the internal `/api/internal/cancel-queued` fast-path
  //     (below).
  //   - abort: `abortTurn` Zero mutator → abort-listener + the
  //     internal `/api/internal/abort-turn` fast-path (below).
  //   - resume: `resumeTurn` Zero mutator → resume-listener.

  // Phase 4.9 fast-path: synchronous in-memory splice of the worker's
  // `nextPrompts` deque. Called by the dashboard's `cancelQueued`
  // wrapper before / alongside dispatching the Zero mutator. The
  // mutator UPDATEs the row to status='cancel_requested' which fires
  // the Postgres trigger; the daemon's LISTEN handler then performs
  // the canonical row DELETE. This endpoint deliberately does NOT
  // delete the row — leaving the DELETE to the LISTEN-path keeps the
  // cancel-row-delete pathway single-sourced and avoids racing the
  // trigger.
  //
  // Idempotent on the in-memory state: re-running after the splice
  // has already happened returns `{ ok: true, already_canceled: true,
  // text: "" }`. The dashboard treats both responses the same way.
  if (method === "POST" && path === "/api/internal/cancel-queued") {
    const body = await readJson<{ block_id?: string }>(req);
    const blockId = body.block_id;
    if (typeof blockId !== "string" || blockId.length === 0) {
      return json(res, 400, { error: "missing_block_id" });
    }
    const block = await getBlockById(blockId);
    if (!block) {
      // Row already deleted (LISTEN-path won the race, or legacy DELETE
      // path already handled it). Idempotent return: nothing to splice,
      // no text to recover.
      return json(res, 200, { ok: true, already_canceled: true, text: "" });
    }
    if (block.status !== "queued" && block.status !== "cancel_requested") {
      return json(res, 409, {
        error: "not_queued",
        block_id: blockId,
        status: block.status,
        message: "Block has already dispatched; use abort instead",
      });
    }
    const removed = removeQueuedPrompt(block.agentName, block.turnId);
    let recoveredText = "";
    try {
      const parsed = JSON.parse(block.contentJson) as { text?: unknown };
      if (typeof parsed.text === "string") recoveredText = parsed.text;
    } catch {
      // Malformed content_json — return empty text; the user retypes.
    }
    return json(res, 200, {
      ok: true,
      already_canceled: removed === null,
      text: recoveredText,
      turn_id: block.turnId,
      agent: block.agentName,
    });
  }

  // Phase 4.10 fast-path: synchronously dispatch the lifecycle
  // `abortTurn(agent)` so the worker's `AbortController` fires before
  // the next SDK step lands. Called by the dashboard's `abortTurn`
  // wrapper before / alongside dispatching the Zero mutator. Idempotent
  // against the LISTEN-path (both call the same lifecycle function).
  //
  // Authenticated callers only (loopback + shared secret enforced at
  // the dashboard's proxy layer).
  if (method === "POST" && path === "/api/internal/abort-turn") {
    const body = await readJson<{ turn_id?: string }>(req);
    const turnId = body.turn_id;
    if (typeof turnId !== "string" || turnId.length === 0) {
      return json(res, 400, { error: "missing_turn_id" });
    }
    const agent = findAgentByTurnId(turnId);
    const aborted = agent ? abortTurn(agent) : false;
    // `aborted=false` means no live worker matched the turn (either
    // it already finished or the abort-listener LISTEN-path already
    // tore it down). The dashboard treats both as success.
    return json(res, 200, { ok: true, aborted, turn_id: turnId, agent });
  }

  // --- Agents ---
  if (method === "GET" && path === "/api/agents") {
    const all: AgentEntry[] = await registry.listAgents();
    // Prefer the in-memory live worker's status over the DB column whenever
    // an agent has a forked worker — the DB lags by however long it takes
    // for setStatus() to land between the worker's status-change and the
    // next poll, which is enough to make the sidebar dot read "idle" while
    // the agent is mid-turn. The live map is the real-time source of truth.
    const merged: AgentEntry[] = all.map((a) => {
      const live = peekLiveWorker(a.name);
      return live ? { ...a, status: live.status } : a;
    });
    const typeFilter = url.searchParams.get("type");
    const statusFilter = url.searchParams.get("status");
    const filtered = merged.filter(
      (a) => (!typeFilter || a.type === typeFilter) && (!statusFilter || a.status === statusFilter),
    );
    // Augment with past-session count so the dashboard sidebar can decide
    // whether an agent has expandable history without N+1 follow-up calls.
    const counts = await sessionCountsByAgent();
    const augmented = filtered.map((a) => ({
      ...a,
      sessionCount: counts[a.name] ?? 0,
    }));
    return json(res, 200, augmented);
  }
  if (method === "GET" && /^\/api\/agents\/[^/]+\/sessions$/.test(path)) {
    const agentName = path.split("/")[3];
    return json(res, 200, await listAgentSessions(agentName));
  }
  if (method === "POST" && path === "/api/agents") {
    const body = await readJson<CreateAgentInput>(req);
    const r = await createAgent(body, cfg);
    return json(res, r.status, r.body);
  }
  if (method === "GET" && /^\/api\/agents\/[^/]+$/.test(path)) {
    const name = path.split("/")[3];
    const a = await registry.getAgent(name);
    if (!a) return json(res, 404, { error: "not found" });
    return json(res, 200, a);
  }
  if (method === "POST" && /^\/api\/agents\/[^/]+\/archive$/.test(path)) {
    // Archive an agent: stop it from receiving work, set status=archived,
    // and (for builders) remove the worktree + force-delete the branch.
    // Sessions persist in perpetuity — this just frees the disk and stops
    // future work. Merged form of the old POST /kill + DELETE /workspace.
    const name = path.split("/")[3];
    const a = await registry.getAgent(name);
    if (!a) return json(res, 404, { error: "not found" });
    // Bare agents registered under an installed app are persistent user-facing
    // interfaces (e.g. the kitchen agent). Archiving them resets the user's
    // conversational context. Block the call.
    if (a.type === "bare") {
      const appId = await registry.getAppId(name);
      if (appId) {
        return json(res, 409, {
          error: `cannot archive "${name}": it is a persistent bare agent registered under app "${appId}". Uninstall the app to remove it.`,
          code: "app_agent_protected",
        });
      }
    }
    // `reason` is required and drives the linked-ticket close behavior
    // (completed→done, abandoned/failed→closed). Refork is daemon-internal
    // and never accepted over the wire.
    const body = await readJson<{ reason?: string }>(req).catch(
      () => ({ reason: undefined }) as { reason?: string },
    );
    const validReasons = ["completed", "abandoned", "failed"] as const;
    type ApiReason = (typeof validReasons)[number];
    if (!body.reason || !validReasons.includes(body.reason as ApiReason)) {
      return json(res, 400, {
        error: `reason required, one of: ${validReasons.join(", ")}`,
      });
    }
    const reason = body.reason as ApiReason;
    const branch = a.type === "builder" && "branch" in a ? a.branch : undefined;
    const repo = process.cwd();
    // F1-B: await the archive so the response is a strong "actually
    // archived" signal — no race against the worker's exit handler.
    await archiveAgent(name, { reason });
    // Workspace cleanup happens only for builders, after archive. Failure
    // here (e.g., worktree dir locked) is non-fatal — log and return the
    // archive result anyway; the agent is already off.
    let workspacePathRemoved: string | undefined;
    if (a.type === "builder") {
      try {
        workspacePathRemoved = workspacePath(name);
        archiveWorkspace(name, repo, { branch });
      } catch (err) {
        logger.log("warn", "agent.archive.workspace.fail", {
          agent: name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return json(res, 200, { ok: true, workspacePath: workspacePathRemoved });
  }
  if (method === "POST" && /^\/api\/agents\/[^/]+\/unarchive$/.test(path)) {
    const name = path.split("/")[3];
    const a = await registry.getAgent(name);
    if (!a) return json(res, 404, { error: "not found" });
    if (a.status !== "archived") {
      return json(res, 409, {
        error: `"${name}" is not archived (status=${a.status})`,
        code: "not_archived",
      });
    }
    try {
      await registry.unarchiveAgent(name);
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return json(res, 200, { ok: true });
  }
  if (method === "POST" && /^\/api\/agents\/[^/]+\/abort$/.test(path)) {
    const name = path.split("/")[3];
    const aborted = abortTurn(name);
    return json(res, 200, { aborted });
  }

  // --- Blocks (canonical transcript) ---
  if (method === "GET" && /^\/api\/agents\/[^/]+\/blocks$/.test(path)) {
    const agentName = path.split("/")[3];
    const limit = numericParam(url, "limit");
    const before = url.searchParams.get("before") ?? undefined;
    const after = url.searchParams.get("after") ?? undefined;
    const aroundTs = numericParam(url, "around_ts");
    const beforeLimit = numericParam(url, "before_limit");
    const afterLimit = numericParam(url, "after_limit");
    const match = url.searchParams.get("match") ?? undefined;
    const sessionId = url.searchParams.get("session_id") ?? undefined;
    try {
      const result = await fetchBlocksByAgent({
        agentName,
        sessionId,
        limit,
        beforeBlockId: before,
        afterBlockId: after,
        aroundTs,
        beforeLimit,
        afterLimit,
        match,
      });
      return json(res, 200, {
        blocks: result.blocks,
      });
    } catch (err) {
      // FTS5 MATCH expressions can throw on syntactically invalid queries
      // (e.g. unbalanced quotes). Return a clean 400 instead of a 500 so
      // the dashboard can surface a "couldn't search" toast.
      return json(res, 400, {
        error: "invalid_query",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Tickets ---
  if (method === "GET" && path === "/api/tickets") {
    const TICKET_STATUSES = ["open", "in_progress", "done", "blocked", "closed"] as const;
    const rawStatus = url.searchParams.get("status");
    const status = (TICKET_STATUSES as readonly string[]).includes(rawStatus ?? "")
      ? (rawStatus as (typeof TICKET_STATUSES)[number])
      : undefined;
    const assignee = url.searchParams.get("assignee") ?? undefined;
    return json(res, 200, await listTickets({ status, assignee }));
  }
  if (method === "POST" && path === "/api/tickets") {
    const body = await readJson<Parameters<typeof createTicket>[0]>(req);
    return json(res, 200, await createTicket(body));
  }
  if (method === "GET" && /^\/api\/tickets\/[^/]+$/.test(path)) {
    const id = path.split("/")[3];
    const t = await getTicket(id);
    if (!t) return json(res, 404, { error: "not found" });
    const ext = await externalLinks(id);
    const comments = await listComments(id);
    return json(res, 200, { ...t, externalLinks: ext, comments });
  }
  if (method === "PATCH" && /^\/api\/tickets\/[^/]+$/.test(path)) {
    const id = path.split("/")[3];
    const body = await readJson<Parameters<typeof updateTicket>[1]>(req);
    return json(res, 200, await updateTicket(id, body));
  }
  if (method === "POST" && /^\/api\/tickets\/[^/]+\/comments$/.test(path)) {
    const id = path.split("/")[3];
    const body = await readJson<{ author: string; body: string }>(req);
    await addComment(id, body.author, body.body);
    return json(res, 200, { ok: true });
  }
  if (method === "POST" && /^\/api\/tickets\/[^/]+\/links$/.test(path)) {
    const id = path.split("/")[3];
    if (!(await getTicket(id))) return json(res, 404, { error: "ticket not found" });
    const body = await readJson<{
      system: string;
      externalId: string;
      url?: string;
      meta?: Record<string, unknown>;
    }>(req);
    if (!body.system || !body.externalId) {
      return json(res, 400, { error: "system and externalId required" });
    }
    await linkExternal({
      ticketId: id,
      system: body.system,
      externalId: body.externalId,
      url: body.url,
      meta: body.meta,
    });
    return json(res, 200, { ok: true });
  }
  if (method === "DELETE" && /^\/api\/tickets\/[^/]+\/links$/.test(path)) {
    const id = path.split("/")[3];
    if (!(await getTicket(id))) return json(res, 404, { error: "ticket not found" });
    const system = url.searchParams.get("system");
    const externalId = url.searchParams.get("externalId");
    if (!system || !externalId) {
      return json(res, 400, {
        error: "system and externalId query params required",
      });
    }
    const removed = await unlinkExternal({ ticketId: id, system, externalId });
    if (!removed) return json(res, 404, { error: "link not found" });
    return json(res, 200, { ok: true });
  }

  // --- Schedules ---
  if (method === "GET" && path === "/api/schedules") {
    return json(res, 200, await listSchedules());
  }
  if (method === "POST" && path === "/api/schedules") {
    const body = await readJson<Parameters<typeof upsertSchedule>[0]>(req);
    try {
      await upsertSchedule(body);
    } catch (err) {
      if (err instanceof ScheduleNameCollisionError) {
        return json(res, 409, { error: err.message });
      }
      return json(res, 400, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return json(res, 200, { ok: true });
  }
  if (method === "POST" && /^\/api\/schedules\/[^/]+\/trigger$/.test(path)) {
    const name = decodeURIComponent(path.split("/")[3]);
    const runId = await triggerSchedule(name);
    if (!runId)
      return json(res, 409, {
        error: "schedule not found or already running",
      });
    return json(res, 200, { runId });
  }
  if (method === "POST" && /^\/api\/schedules\/[^/]+\/(pause|resume)$/.test(path)) {
    const name = decodeURIComponent(path.split("/")[3]);
    const action = path.split("/")[4];
    const ok = action === "pause" ? await pauseSchedule(name) : await resumeSchedule(name);
    if (!ok) return json(res, 404, { error: "schedule not found" });
    return json(res, 200, { ok: true });
  }
  if (method === "GET" && /^\/api\/schedules\/[^/]+$/.test(path)) {
    const name = decodeURIComponent(path.split("/")[3]);
    const r = await getSchedule(name);
    if (!r) return json(res, 404, { error: "schedule not found" });
    return json(res, 200, r);
  }
  if (method === "GET" && /^\/api\/schedules\/[^/]+\/state$/.test(path)) {
    const name = decodeURIComponent(path.split("/")[3]);
    if (!(await getSchedule(name))) return json(res, 404, { error: "schedule not found" });
    return json(res, 200, readScheduleArtifacts(name));
  }
  if (method === "DELETE" && /^\/api\/schedules\/[^/]+$/.test(path)) {
    const name = decodeURIComponent(path.split("/")[3]);
    const ok = await deleteSchedule(name);
    if (!ok) return json(res, 404, { error: "schedule not found" });
    return json(res, 200, { ok: true });
  }

  // --- Memory ---
  if (method === "GET" && path === "/api/memory") {
    return json(res, 200, await listEntries());
  }
  if (method === "GET" && path === "/api/memory/search") {
    const q = url.searchParams.get("q") ?? "";
    const tagsParam = url.searchParams.get("tags");
    const limitParam = url.searchParams.get("limit");
    const tags = tagsParam
      ? tagsParam
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;
    const limit = limitParam ? Math.max(1, Number(limitParam) || 10) : undefined;
    if (!q.trim()) return json(res, 400, { error: "q parameter required" });
    const results = await searchMemories({
      query: q,
      tags,
      limit,
      trackRecall: false,
    });
    return json(res, 200, results);
  }
  if (method === "POST" && path === "/api/memory") {
    const body = await readJson<{
      id?: string;
      title: string;
      content: string;
      tags?: string[];
    }>(req);
    if (!body.title || !body.content) {
      return json(res, 400, { error: "title and content required" });
    }
    const id = (body.id?.trim() || slugifyMemoryId(body.title)).slice(0, 64);
    if (!id) return json(res, 400, { error: "could not derive id from title" });
    const callerName = String(req.headers["x-friday-caller-name"] ?? "user");
    const now = new Date().toISOString();
    const existing = await getEntry(id);
    const entry: MemoryEntry = {
      id,
      title: body.title,
      content: body.content,
      tags: body.tags ?? existing?.tags ?? [],
      createdBy: existing?.createdBy ?? callerName,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      recallCount: existing?.recallCount ?? 0,
      lastRecalledAt: existing?.lastRecalledAt ?? null,
    };
    await saveEntry(entry);
    return json(res, existing ? 200 : 201, entry);
  }
  if (method === "GET" && /^\/api\/memory\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[3]);
    const e = await getEntry(id);
    if (!e) return json(res, 404, { error: "not found" });
    // FIX_FORWARD 6.8 follow-up: bumping `recallCount` on every dashboard
    // page view (load, edit, delete, invalidateAll) pollutes the metric
    // that's supposed to reflect agent-side recall frequency. Require an
    // explicit `?recall=1` from callers that want the bump (the
    // auto-recall block uses `searchMemories`, which touches on its own).
    if (url.searchParams.get("recall") === "1") {
      await touchRecall(id);
    }
    return json(res, 200, e);
  }
  if (method === "PATCH" && /^\/api\/memory\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[3]);
    if (!(await getEntry(id))) return json(res, 404, { error: "not found" });
    const patch = await readJson<{
      title?: string;
      content?: string;
      tags?: string[];
    }>(req);
    await updateEntry(id, patch);
    return json(res, 200, await getEntry(id));
  }
  if (method === "DELETE" && /^\/api\/memory\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[3]);
    if (!(await getEntry(id))) return json(res, 404, { error: "not found" });
    await forgetEntry(id);
    return json(res, 200, { ok: true });
  }

  // --- Evolve ---
  if (method === "GET" && path === "/api/evolve/proposals") {
    const all = listProposals();
    const statusFilter = url.searchParams.get("status");
    const typeFilter = url.searchParams.get("type");
    const filtered = all.filter(
      (p) => (!statusFilter || p.status === statusFilter) && (!typeFilter || p.type === typeFilter),
    );
    return json(res, 200, filtered);
  }
  if (method === "POST" && path === "/api/evolve/proposals") {
    const body = await readJson<Omit<SaveProposalInput, "createdBy">>(req);
    if (!body.title || !body.proposedChange || !body.type) {
      return json(res, 400, {
        error: "title, type, and proposedChange are required",
      });
    }
    const callerName = String(req.headers["x-friday-caller-name"] ?? "user");
    const p = saveProposal({ ...body, createdBy: callerName });
    // Item #54: project the FS write to Postgres so /evolve's Zero
    // reactive query sees the new row. Fire-and-forget — FS stays
    // canonical; a PG sync failure logs but doesn't fail the HTTP 201.
    void syncProposalToPg(p.id);
    return json(res, 201, p);
  }
  if (method === "GET" && /^\/api\/evolve\/proposals\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[4]);
    const p = getProposal(id);
    if (!p) return json(res, 404, { error: "proposal not found" });
    return json(res, 200, p);
  }
  if (method === "PATCH" && /^\/api\/evolve\/proposals\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[4]);
    if (!getProposal(id)) return json(res, 404, { error: "proposal not found" });
    const patch = await readJson<UpdateProposalInput>(req);
    const next = updateProposal(id, patch);
    void syncProposalToPg(id);
    return json(res, 200, next);
  }
  if (method === "DELETE" && /^\/api\/evolve\/proposals\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[4]);
    if (!deleteProposal(id)) return json(res, 404, { error: "proposal not found" });
    void deleteProposalFromPg(id);
    return json(res, 200, { ok: true });
  }
  if (method === "POST" && /^\/api\/evolve\/proposals\/[^/]+\/apply$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[4]);
    const p = getProposal(id);
    if (!p) return json(res, 404, { error: "proposal not found" });
    if (p.status === "applied") {
      return json(res, 409, {
        error: `proposal already applied (ticket ${p.appliedTicketId ?? "<unknown>"})`,
      });
    }
    const body = await readJson<{
      ticketKind?: "task" | "epic" | "bug" | "chore";
      assignee?: string;
    }>(req);
    const callerName = String(req.headers["x-friday-caller-name"] ?? "user");
    const ticket = await createTicket({
      title: p.title,
      body: renderProposalForTicket(p),
      kind: body.ticketKind ?? "task",
      assignee: body.assignee,
      meta: { evolveProposalId: p.id },
    });
    const updated = updateProposal(id, {
      status: "applied",
      appliedAt: new Date().toISOString(),
      appliedBy: callerName,
      appliedTicketId: ticket.id,
    });
    void syncProposalToPg(id);
    return json(res, 200, { proposal: updated, ticket });
  }
  if (method === "POST" && /^\/api\/evolve\/proposals\/[^/]+\/dismiss$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[4]);
    const p = getProposal(id);
    if (!p) return json(res, 404, { error: "proposal not found" });
    const body = await readJson<{ reason?: string }>(req);
    const newBody = body.reason
      ? `${p.proposedChange}\n\n---\n\n## Dismissed\n\n${body.reason}`
      : p.proposedChange;
    const updated = updateProposal(id, {
      status: "rejected",
      proposedChange: newBody,
    });
    void syncProposalToPg(id);
    return json(res, 200, updated);
  }

  if (method === "POST" && path === "/api/evolve/scan") {
    const body = await readJson<{
      windowHours?: number;
      includeFriction?: boolean;
      includePreferences?: boolean;
    }>(req);
    const windowHours = body.windowHours ?? 24;
    const includeFriction = body.includeFriction !== false;
    const includePreferences = body.includePreferences !== false;
    const callerName = String(req.headers["x-friday-caller-name"] ?? "scan");
    const since = sinceHoursAgo(windowHours);
    const windowEnd = new Date().toISOString();
    try {
      const syncSignals = await scanAll({ since });
      const frictionSignals = includeFriction
        ? await scanFriction({ since }).catch((err) => {
            logger.log("warn", "evolve.scan.friction-error", {
              message: err instanceof Error ? err.message : String(err),
            });
            return [] as typeof syncSignals;
          })
        : [];
      const preferenceSignals = includePreferences
        ? await scanPreferences({ since }).catch((err) => {
            logger.log("warn", "evolve.scan.preferences-error", {
              message: err instanceof Error ? err.message : String(err),
            });
            return [] as typeof syncSignals;
          })
        : [];
      const signals = [...syncSignals, ...frictionSignals, ...preferenceSignals];
      const propose = proposeFromSignals(signals, {
        rule: DEFAULT_RULE,
        createdBy: callerName,
      });
      const reranked = rerankAll(DEFAULT_RULE);
      appendRun({
        ts: windowEnd,
        by: callerName,
        windowStart: since,
        windowEnd,
        signalsScanned: signals.length,
        proposalsCreated: propose.created.length,
        proposalsUpdated: propose.updated.length,
        promotedToCritical: propose.promotedToCritical.length,
      });
      // FRI-40 Phase 1: when enabled, auto-spawn a read-only triage helper
      // for each proposal that just promoted to critical — across BOTH
      // promote surfaces (fresh-create + rerank). Read with a strict
      // `=== true` so the shallow-merge `{ evolve: {} }` case stays off.
      // Spawn failures must never alter the scan's returned summary nor
      // throw out of the handler (AC #7); the in-process `createAgent` 409
      // gives idempotent dedup against an already-spawned triage helper
      // (AC #6).
      if (cfg.evolve?.autoSpawnTriageHelpers === true) {
        try {
          const triage = triageSpawnPlan([...propose.promotedToCritical, ...reranked.promoted]);
          for (const t of triage) {
            try {
              const r = await createAgent(
                {
                  type: "helper",
                  name: t.name,
                  parentName: "scheduled-meta-daily",
                  prompt: t.prompt,
                  reason: t.reason,
                },
                cfg,
              );
              if (r.status === 201)
                logger.log("info", "evolve.triage.spawn", { name: t.name, reason: t.reason });
              else if (r.status === 409)
                logger.log("info", "evolve.triage.spawn.skip", { name: t.name, status: 409 });
              else
                logger.log("warn", "evolve.triage.spawn.error", { name: t.name, status: r.status });
            } catch (err) {
              logger.log("warn", "evolve.triage.spawn.error", {
                name: t.name,
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } catch (err) {
          logger.log("warn", "evolve.triage.spawn.error", {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // FRI-149 Phase 2: when enabled, auto-spawn an auto-fixing Builder for
      // each proposal that just promoted to critical AND is code-shaped AND
      // carries a high-severity signal — across BOTH promote surfaces. The
      // Builder iterates in its worktree, drives the fix to a GREEN review-ready
      // PR, mails the orchestrator the PR URL, and STOPS (it never merges; the
      // human approval gate moves to merge — ADR-036). Read with a strict
      // `=== true` so the shallow-merge `{ evolve: {} }` case stays off. The
      // carve-out that lets a `scheduled` caller spawn a builder is gated on the
      // un-forgeable `evolveEscalation` arg passed ONLY here (never reachable
      // from the wire — see validateSpawnPermissions / createAgent). Spawn
      // failures are caught per-request AND for the whole block, so they never
      // alter the scan's returned summary nor throw out of the handler; the
      // in-process `createAgent` 409 gives idempotent dedup against an
      // already-spawned `builder-<id>`.
      if (cfg.evolve?.autoSpawnBuilders === true) {
        try {
          const builders = builderEscalationPlan([
            ...propose.promotedToCritical,
            ...reranked.promoted,
          ]);
          for (const b of builders) {
            try {
              const proposalId = b.name.slice("builder-".length);
              const r = await createAgent(
                {
                  type: "builder",
                  name: b.name,
                  parentName: "scheduled-meta-daily",
                  prompt: b.prompt,
                  reason: b.reason,
                  ticketId: proposalId,
                  worktree: { repo: process.cwd() },
                },
                cfg,
                { evolveEscalation: true },
              );
              if (r.status === 201) {
                logger.log("info", "evolve.builder.spawn", {
                  name: b.name,
                  proposalId,
                  reason: b.reason,
                });
                // Two-way linkage: record the in-flight builder on the proposal
                // so the dashboard can connect a critical proposal to its
                // builder. Branch is derivable as friday/builder-<id>; the PR
                // URL arrives via the builder's mail.
                try {
                  updateProposal(proposalId, { builderAgent: b.name });
                } catch (err) {
                  logger.log("warn", "evolve.builder.linkage.error", {
                    name: b.name,
                    proposalId,
                    message: err instanceof Error ? err.message : String(err),
                  });
                }
                // Notify the orchestrator that an escalation builder is in
                // flight; it surfaces this to the user, and the builder itself
                // mails the review-ready PR URL once CI is green.
                try {
                  await sendMail({
                    fromAgent: "scheduled-meta-daily",
                    toAgent: cfg.orchestratorName,
                    type: "notification",
                    subject: `evolve escalation: ${proposalId}`,
                    body:
                      `Auto-escalated critical+code proposal \`${proposalId}\` to Builder \`${b.name}\`. ` +
                      `It will drive a GREEN, review-ready PR (branch friday/${b.name}) and mail you the PR URL — it will NOT merge. ` +
                      `You review and merge.`,
                  });
                } catch (err) {
                  logger.log("warn", "evolve.builder.notify.error", {
                    name: b.name,
                    proposalId,
                    message: err instanceof Error ? err.message : String(err),
                  });
                }
              } else if (r.status === 409) {
                logger.log("info", "evolve.builder.spawn.skip", { name: b.name, status: 409 });
              } else {
                logger.log("warn", "evolve.builder.spawn.error", {
                  name: b.name,
                  status: r.status,
                });
              }
            } catch (err) {
              logger.log("warn", "evolve.builder.spawn.error", {
                name: b.name,
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } catch (err) {
          logger.log("warn", "evolve.builder.spawn.error", {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return json(res, 200, {
        signals: signals.length,
        created: propose.created.length,
        updated: propose.updated.length,
        promotedToCritical: propose.promotedToCritical.length,
        reranked: reranked.reranked.length,
        promotedFromRerank: reranked.promoted.length,
        familyResolved: propose.familyResolved.length,
        familyRejected: propose.familyRejected.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendRun({
        ts: windowEnd,
        by: callerName,
        windowStart: since,
        windowEnd,
        signalsScanned: 0,
        proposalsCreated: 0,
        proposalsUpdated: 0,
        promotedToCritical: 0,
        note: `error: ${message}`,
      });
      return json(res, 500, { error: message });
    }
  }
  if (method === "POST" && path === "/api/evolve/enrich") {
    const body = await readJson<{
      id?: string;
      retryFailed?: boolean;
      force?: boolean;
      limit?: number;
    }>(req);
    try {
      const result = await enrichProposals(body);
      return json(res, 200, {
        enriched: result.enriched.length,
        skipped: result.skipped,
        failed: result.failed,
      });
    } catch (err) {
      return json(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (method === "POST" && path === "/api/evolve/cluster") {
    const body = await readJson<{ threshold?: number }>(req);
    try {
      const result = mergeClusters({ threshold: body.threshold });
      return json(res, 200, {
        clustersCreated: result.clustersCreated.length,
        clustersUpdated: result.clustersUpdated.length,
        proposalsAttached: result.proposalsAttached,
      });
    } catch (err) {
      return json(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Integrations: Linear ---
  if (method === "POST" && path === "/api/integrations/linear/import") {
    const body = await readJson<{ identifier?: string }>(req);
    if (!body.identifier) {
      return json(res, 400, { error: "identifier required" });
    }
    try {
      const result = await linearImportIssue({ identifier: body.identifier });
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (method === "POST" && path === "/api/integrations/linear/create-issue") {
    const body = await readJson<{
      title?: string;
      body?: string;
      team?: string;
      priority?: LinearPriority;
    }>(req);
    if (!body.title) {
      return json(res, 400, { error: "title required" });
    }
    if (!loadFridayConfig().linearApiKey) {
      return json(res, 400, { error: "LINEAR_API_KEY not set" });
    }
    const teamOverride = body.team;
    const restore = teamOverride
      ? (() => {
          const prev = process.env.FRIDAY_LINEAR_TEAM;
          process.env.FRIDAY_LINEAR_TEAM = teamOverride;
          return () => {
            if (prev === undefined) delete process.env.FRIDAY_LINEAR_TEAM;
            else process.env.FRIDAY_LINEAR_TEAM = prev;
          };
        })()
      : () => {};
    try {
      const { issue } = await linearCreateIssue({
        title: body.title,
        description: body.body,
        priority: body.priority,
      });
      return json(res, 200, {
        identifier: issue.identifier,
        url: issue.url,
        id: issue.id,
      });
    } catch (err) {
      const status = err instanceof LinearApiError ? 502 : 500;
      return json(res, status, {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      restore();
    }
  }
  if (method === "POST" && path === "/api/integrations/linear/update-issue") {
    const body = await readJson<{
      identifier?: string;
      title?: string;
      body?: string;
      state?: LinearStateType;
      priority?: LinearPriority;
    }>(req);
    if (!body.identifier) {
      return json(res, 400, { error: "identifier required" });
    }
    const apiKey = loadFridayConfig().linearApiKey;
    if (!apiKey) {
      return json(res, 400, { error: "LINEAR_API_KEY not set" });
    }
    if (
      body.title === undefined &&
      body.body === undefined &&
      body.state === undefined &&
      body.priority === undefined
    ) {
      return json(res, 400, {
        error: "at least one of title, body, state, priority must be provided",
      });
    }
    const teamKeyMatch = body.identifier.match(/^([A-Z][A-Z0-9_]*)-(\d+)$/);
    if (!teamKeyMatch) {
      return json(res, 400, {
        error: `invalid Linear identifier: ${body.identifier}`,
      });
    }
    const teamKey = teamKeyMatch[1];
    try {
      const issueId = await linearResolveIssueIdByIdentifier({
        apiKey,
        identifier: body.identifier,
      });
      if (!issueId) {
        return json(res, 404, {
          error: `Linear issue not found: ${body.identifier}`,
        });
      }
      const input: UpdateIssueInput = {};
      if (body.title !== undefined) input.title = body.title;
      if (body.body !== undefined) input.description = body.body;
      if (body.priority !== undefined) input.priority = body.priority;
      if (body.state !== undefined) {
        const stateId = await linearGetStateIdByType({
          apiKey,
          teamKey,
          stateType: body.state,
        });
        if (!stateId) {
          return json(res, 400, {
            error: `No Linear workflow state of type "${body.state}" on team "${teamKey}"`,
          });
        }
        input.stateId = stateId;
      }
      const updated = await linearUpdateIssue({
        apiKey,
        id: issueId,
        input,
      });
      return json(res, 200, {
        identifier: updated.identifier,
        title: updated.title,
        url: updated.url,
      });
    } catch (err) {
      const status = err instanceof LinearApiError ? 502 : 500;
      return json(res, status, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (method === "POST" && path === "/api/integrations/linear/reconcile") {
    try {
      const result = await linearReconcile();
      // FRI-66: tickets reconcile just back-propagated to terminal need
      // their originating evolve proposals flipped to `applied`.
      if (result.closedTicketIds.length > 0) {
        await syncProposalsForClosedTickets(result.closedTicketIds);
      }
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Mail ---
  if (method === "GET" && /^\/api\/mail\/inbox\/[^/]+$/.test(path)) {
    const agent = path.split("/")[4];
    return json(res, 200, await inbox(agent));
  }
  if (method === "POST" && path === "/api/mail/send") {
    const body = await readJson<Parameters<typeof sendMail>[0]>(req);
    // FIX_FORWARD 5.7: per-agent mail rate limit — 50 mails / 5min / from.
    // A runaway tool that spams the orchestrator can't drown the mail bus.
    const fromAgent = body.fromAgent || "__unknown__";
    const r = await consumeRateLimit({
      key: `mail:${fromAgent}`,
      windowMs: 5 * 60 * 1000,
      max: 50,
    });
    if (!r.allowed) {
      return json(res, 429, {
        error: "rate_limited",
        detail: `agent ${fromAgent} exceeded 50 mails / 5 min`,
        retry_after_ms: r.retryAfterMs,
      });
    }
    // FRI-11 F3: resolve symbolic recipients ("parent" / "self") against the
    // caller's registry row before validation. Literal names pass through.
    const resolved = await resolveRecipient(fromAgent, body.toAgent);
    if (!resolved.ok) {
      return json(res, 400, { error: resolved.error });
    }
    // FRI-11 F2: reject mail to unknown recipients before persisting the row.
    // The MCP tool surfaces this 400 to the caller as a daemonFetch error —
    // the agent sees the suggestion immediately instead of silently writing
    // an undeliverable mail row.
    const check = await validateRecipient(resolved.agent);
    if (!check.ok) {
      return json(res, 400, {
        error: check.error,
        suggestion: check.suggestion,
      });
    }
    return json(res, 200, await sendMail({ ...body, toAgent: check.agent }));
  }
  if (method === "POST" && /^\/api\/mail\/\d+\/read$/.test(path)) {
    const id = Number(path.split("/")[3]);
    const row = await getMail(id);
    if (!row) return json(res, 404, { error: "mail not found" });
    await markRead(id);
    return json(res, 200, { ...row, delivery: "read", readAt: Date.now() });
  }
  if (method === "POST" && /^\/api\/mail\/\d+\/close$/.test(path)) {
    const id = Number(path.split("/")[3]);
    const row = await getMail(id);
    if (!row) return json(res, 404, { error: "mail not found" });
    await closeMail(id);
    return json(res, 200, { ok: true });
  }

  if (method === "GET" && path === "/api/mail/search") {
    const q = url.searchParams.get("q") ?? undefined;
    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;
    const involves = url.searchParams.get("involves") ?? undefined;
    const typeRaw = url.searchParams.get("type");
    const deliveryRaw = url.searchParams.get("delivery");
    const priorityRaw = url.searchParams.get("priority");
    const since = url.searchParams.get("since") ?? undefined;
    const until = url.searchParams.get("until") ?? undefined;
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "") || 100, 500);
    const offset = parseInt(url.searchParams.get("offset") ?? "") || 0;

    const type = typeRaw
      ? (typeRaw.split(",").filter(Boolean) as Array<"message" | "notification" | "task">)
      : undefined;
    const delivery = deliveryRaw
      ? (deliveryRaw.split(",").filter(Boolean) as Array<"pending" | "read" | "closed">)
      : undefined;
    const priority = priorityRaw
      ? (priorityRaw.split(",").filter(Boolean) as Array<"normal" | "critical">)
      : undefined;

    try {
      const result = await searchMail({
        q,
        from,
        to,
        involves,
        type,
        delivery,
        priority,
        since,
        until,
        limit,
        offset,
      });
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // --- Attachments / uploads ---
  // Body is the raw file bytes; headers carry the metadata. Avoids the
  // multipart-parsing complexity that adds nothing for a single-file form.
  // Dashboard hits this with `fetch(url, { method: "POST", body: file,
  // headers: { "content-type": file.type, "x-filename": file.name } })`.
  //
  // Auth: same-machine shared-secret header + Host-header check. The daemon
  // binds 127.0.0.1, but that alone doesn't stop DNS-rebind attacks (a
  // hostile page resolving an attacker hostname to 127.0.0.1) or other
  // local processes. The shared secret is generated on first run, mode
  // 0600, and read by the dashboard at startup so its proxy can inject the
  // header.
  if (method === "POST" && path === "/api/uploads") {
    if (!authorizeSameHost(req)) {
      return json(res, 401, { error: "unauthorized" });
    }
    const contentLength = Number(req.headers["content-length"] ?? 0);
    // FIX_FORWARD 5.5: 15 MB hard cap, enforced at stream-receive so a
    // pathological client can't pump gigabytes before sharp gets involved.
    // Anthropic's vision API caps attachments around 20 MB; 15 MB leaves
    // headroom for downstream re-encodes while still bounding daemon RAM.
    const MAX_BYTES = 15 * 1024 * 1024;
    if (contentLength > MAX_BYTES) {
      return json(res, 413, {
        error: `file exceeds ${MAX_BYTES} bytes`,
      });
    }
    const filename = String(req.headers["x-filename"] ?? "upload").slice(0, 255);
    const mime = String(req.headers["content-type"] ?? "application/octet-stream");
    if (!ATTACHMENT_MIME_ALLOWLIST.has(mime.toLowerCase())) {
      return json(res, 415, {
        error: `unsupported mime: ${mime}`,
        allowed: [...ATTACHMENT_MIME_ALLOWLIST],
      });
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;
    try {
      for await (const c of req) {
        const buf = c as Buffer;
        received += buf.length;
        if (received > MAX_BYTES) {
          // Tear down the connection. Without `req.destroy()` the loop's
          // early return doesn't actually stop the client from sending; a
          // chunked request that lies about content-length could keep
          // amplifying memory until the network runs out of patience.
          aborted = true;
          req.destroy();
          return json(res, 413, {
            error: `file exceeds ${MAX_BYTES} bytes`,
          });
        }
        chunks.push(buf);
      }
    } catch (err) {
      if (aborted) return; // already responded
      return json(res, 400, {
        error: `read failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length === 0) {
      return json(res, 400, { error: "empty body" });
    }
    try {
      const att = await uploadAttachment({ bytes, filename, mime });
      return json(res, 200, {
        sha256: att.sha256,
        filename: att.filename,
        mime: att.mime,
        sizeBytes: att.sizeBytes,
      });
    } catch (err) {
      return json(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (method === "GET" && /^\/api\/uploads\/[a-f0-9]{64}$/.test(path)) {
    if (!authorizeSameHost(req)) {
      return json(res, 401, { error: "unauthorized" });
    }
    const sha = path.split("/")[3];
    const bytes = await readAttachmentBytes(sha);
    if (!bytes) return json(res, 404, { error: "not found" });
    const meta = await getAttachment(sha);
    const rawMime = (meta?.mime ?? "application/octet-stream").toLowerCase();
    // Only allow inline rendering for a small, well-understood set of
    // MIME types. Anything else is forced to `application/octet-stream`
    // with `Content-Disposition: attachment` so the browser downloads
    // rather than parses it. `nosniff` blocks browser MIME-sniffing,
    // which would otherwise re-derive a dangerous type from the bytes.
    const inlineSafe = INLINE_SERVE_MIME_ALLOWLIST.has(rawMime);
    const contentType = inlineSafe ? rawMime : "application/octet-stream";
    const safeFilename = sanitizeFilenameForHeader(meta?.filename ?? sha);
    const headers: Record<string, string> = {
      "content-type": contentType,
      "content-length": String(bytes.length),
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    };
    if (!inlineSafe) {
      headers["content-disposition"] =
        `attachment; filename="${safeFilename.ascii}"; filename*=UTF-8''${safeFilename.rfc5987}`;
    }
    res.writeHead(200, headers);
    res.end(bytes);
    return;
  }

  // --- Apps (FRI-78) ---
  if (method === "GET" && path === "/api/apps") {
    if (!authorizeSameHost(req)) {
      return json(res, 401, { error: "unauthorized" });
    }
    const list = await listApps();
    const rows = await Promise.all(
      list.map(async (r) => {
        const detail = await inspectApp(r.id);
        return {
          ...r,
          agents: detail?.agents ?? [],
          schedules: detail?.schedules ?? [],
          mcpServers: detail?.mcpServers ?? [],
        };
      }),
    );
    return json(res, 200, rows);
  }
  if (method === "POST" && path === "/api/apps") {
    if (!authorizeSameHost(req)) {
      return json(res, 401, { error: "unauthorized" });
    }
    const body = await readJson<{ folderPath: string; adopt?: boolean }>(req);
    if (!body.folderPath) {
      return json(res, 400, { error: "folderPath required" });
    }
    try {
      const result = await installApp(body.folderPath, { adopt: !!body.adopt });
      return json(res, 201, result);
    } catch (err) {
      if (err instanceof AppInstallError) {
        const status =
          err.code === "already_installed"
            ? 409
            : err.code === "agent_name_collision" ||
                err.code === "schedule_name_collision" ||
                err.code === "mcp_name_collision"
              ? 409
              : 400;
        return json(res, status, { error: err.message, code: err.code });
      }
      return json(res, 400, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (method === "GET" && /^\/api\/apps\/[^/]+$/.test(path)) {
    if (!authorizeSameHost(req)) {
      return json(res, 401, { error: "unauthorized" });
    }
    const id = decodeURIComponent(path.split("/")[3]);
    const row = await inspectApp(id);
    if (!row) return json(res, 404, { error: "not found" });
    return json(res, 200, row);
  }
  if (method === "DELETE" && /^\/api\/apps\/[^/]+$/.test(path)) {
    if (!authorizeSameHost(req)) {
      return json(res, 401, { error: "unauthorized" });
    }
    const id = decodeURIComponent(path.split("/")[3]);
    const body = await readJson<{
      folderDisposition?: "archive" | "keep" | "delete";
    }>(req).catch(() => ({}) as { folderDisposition?: "archive" | "keep" | "delete" });
    try {
      const result = await uninstallApp(id, {
        folderDisposition: body.folderDisposition,
      });
      return json(res, 200, result);
    } catch (err) {
      if (err instanceof AppInstallError) {
        return json(res, 404, { error: err.message, code: err.code });
      }
      return json(res, 400, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (method === "POST" && /^\/api\/apps\/[^/]+\/reload$/.test(path)) {
    if (!authorizeSameHost(req)) {
      return json(res, 401, { error: "unauthorized" });
    }
    const id = decodeURIComponent(path.split("/")[3]);
    let result!: { id: string; changed: boolean };
    try {
      result = await reloadApp(id);
    } catch (err) {
      if (err instanceof AppInstallError) {
        return json(res, 404, { error: err.message, code: err.code });
      }
      return json(res, 400, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    let stoppedWorkers = 0;
    // Stop workers even when manifest unchanged — picks up rotated secrets.
    try {
      stoppedWorkers = await stopWorkersForApp(id);
    } catch (err) {
      logger.log("warn", "app.reload.stop-workers.fail", {
        app: id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return json(res, 200, { ...result, stoppedWorkers });
  }

  return json(res, 404, { error: "not found", path });
}

/** Request shape for `createAgent` — the same object `POST /api/agents` parses. */
export interface CreateAgentInput {
  type: AgentType;
  name: string;
  parentName: string;
  prompt: string;
  model?: string;
  ticketId?: string;
  worktree?: { repo: string; branch?: string; fromRef?: string };
  reason?: string;
}

/**
 * Core agent-creation logic, extracted from the `POST /api/agents` route so
 * that in-process callers (the evolve auto-triage hook, FRI-40) can reuse it
 * without an HTTP round-trip. Behavior is byte-for-byte identical to the old
 * route body: it performs name validation (400), the duplicate-name check
 * (409 via `registry.getAgent`), the type check (400), the ADR-022
 * spawn-permission gate, workspace creation for builders, `registerAgent`,
 * `agent.spawn` telemetry, prompt assembly, the spawn user-block, and
 * `dispatchTurn`, then returns `{ status: 201, body: { name, turn_id } }`.
 *
 * Returning the 409 from inside this function is what gives the in-process
 * evolve call its dedup: a second scan that re-promotes the same proposal
 * hits the existing `triage-<id>` row and gets a 409, not a duplicate spawn.
 */
async function createAgent(
  body: CreateAgentInput,
  cfg: ReturnType<typeof loadConfig>,
  opts?: { evolveEscalation?: boolean },
): Promise<{ status: number; body: unknown }> {
  if (!body.name || !isValidAgentName(body.name)) {
    return {
      status: 400,
      body: {
        error: "invalid name (must be lowercase alphanumeric + dashes, up to 64 chars)",
      },
    };
  }
  if (await registry.getAgent(body.name)) {
    return { status: 409, body: { error: `agent "${body.name}" already exists` } };
  }
  if (
    body.type !== "builder" &&
    body.type !== "helper" &&
    body.type !== "bare" &&
    body.type !== "planner"
  ) {
    return {
      status: 400,
      body: { error: `cannot create agent of type "${body.type}" via this endpoint` },
    };
  }

  // ADR-022 spawn-permission gate. Resolve the caller's agent type by
  // looking up the parent row; absent parent ⇒ implicit orchestrator
  // (matches the implicit-create path in POST /api/chat/turn). Non-
  // orchestrator callers are restricted to spawning helpers and planners
  // (FRI-16) and must include a non-empty `reason`; planners are leaves
  // and cannot spawn at all.
  const callerRow = body.parentName ? await registry.getAgent(body.parentName) : null;
  const callerType: CallerType = callerRow?.type ?? "orchestrator";
  // FRI-149: `opts.evolveEscalation` is the un-forgeable carve-out marker. It is
  // a SEPARATE argument to this function (not a `body` / `CreateAgentInput`
  // field), so the public `POST /api/agents` route — which calls
  // `createAgent(body, cfg)` with no third arg — can never set it. Only the
  // in-process evolve scan hook passes `{ evolveEscalation: true }`.
  const rejection = validateSpawnPermissions({ type: body.type, reason: body.reason }, callerType, {
    evolveEscalation: opts?.evolveEscalation === true,
  });
  if (rejection) {
    return { status: rejection.status, body: rejection.body };
  }
  const persistedReason = callerType === "orchestrator" ? null : (body.reason ?? "").trim() || null;

  let workingDirectory = process.cwd();
  let worktreePath: string | undefined;
  let branch: string | undefined;
  if (body.type === "builder") {
    const repo = body.worktree?.repo ?? process.cwd();
    branch = body.worktree?.branch ?? `friday/${body.name}`;
    try {
      const ws = createWorkspace({
        name: body.name,
        baseRepo: repo,
        branch,
        fromRef: body.worktree?.fromRef,
      });
      workingDirectory = ws.path;
      worktreePath = ws.path;
    } catch (err) {
      return {
        status: 500,
        body: {
          error: `workspace creation failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  // §9: propagate the spawning agent's `appId` to its child. Builders are
  // exempt — workspace containment (worktree cwd) is the stronger rule,
  // and builders can't be declared in a manifest in v1 anyway.
  const inheritedAppId =
    body.type !== "builder" && body.parentName ? await registry.getAppId(body.parentName) : null;
  await registry.registerAgent({
    name: body.name,
    type: body.type,
    parentName: body.parentName,
    ticketId: body.ticketId,
    worktreePath,
    branch,
    appId: inheritedAppId ?? undefined,
    spawnReason: persistedReason,
  });

  // FRI-16: planners inherit their parent's cwd (a planner under a builder
  // runs inside that builder's worktree, middle-path guarded). Resolve via
  // the same registry helper every other dispatch path (mail respawn,
  // watchdog refork, dispatch-listener) uses, so the spawn turn and every
  // later turn agree on the session cwd — the SDK encodes cwd into the
  // JSONL transcript path, and divergence breaks session resume (FRI-61).
  if (body.type === "planner") {
    const plannerRow = await registry.getAgent(body.name);
    if (plannerRow) {
      workingDirectory = await registry.workingDirectoryFor(plannerRow);
    }
  }

  // ADR-022 telemetry: emit one `agent.spawn` event per successful
  // spawn. Walks the parent chain to record true `depth` (1 =
  // orchestrator-rooted) and the orchestrator-rooted `parentChain`
  // capped at SPAWN_PARENT_CHAIN_CAP. The evolve depth scanner
  // (`scanAgentSpawnDepth`) feeds off these lines.
  try {
    const { depth, parentChain } = await computeSpawnDepth(body.parentName, registry.getAgent);
    logger.log("info", "agent.spawn", {
      parent: body.parentName,
      child: body.name,
      type: body.type,
      depth,
      parentChain,
      reason: persistedReason,
    });
  } catch (err) {
    // Telemetry failure must never block the spawn — the row is
    // already persisted and the worker is about to dispatch.
    logger.log("warn", "agent.spawn.telemetry.error", {
      agent: body.name,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const turnId = `t_${randomUUID()}`;
  const { systemPrompt: baseSystemPrompt } = await buildSystemPrompt({
    name: body.name,
    type: body.type,
    parentName: body.parentName,
  });
  const bootstrapResults = await runHooks("agent:bootstrap", {
    agentName: body.name,
    agentType: body.type,
    workingDirectory: worktreePath ?? workingDirectory,
    branch,
    parentName: body.parentName,
    spawnPrompt: body.prompt,
  });
  const bootstrapAppends = bootstrapResults
    .map((r) => r?.appendSystemPrompt)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  const bootstrapAugmentedBase =
    bootstrapAppends.length > 0
      ? `${baseSystemPrompt}\n\n---\n\n${bootstrapAppends.join("\n\n")}`
      : baseSystemPrompt;
  const modelCfg = resolveModelForRole(cfg, body.type);
  const { body: wrappedSpawnPrompt, systemPrompt: spawnSystemPrompt } = await buildDispatchPrompt(
    { name: body.name, type: body.type, parentName: body.parentName },
    {
      kind: "agent_spawn",
      userText: body.prompt,
      baseSystemPromptOverride: bootstrapAugmentedBase,
      parentName: body.parentName,
    },
  );
  // FRI-71: persist the spawn-time prompt as a user block so the very first
  // turn renders with the originating user bubble (not just an orphan
  // assistant reply). The session id isn't known yet — `recordUserBlock`
  // falls back to '__pending__' and the post-turn JSONL recovery rewrites
  // it once the SDK assigns a real id.
  try {
    await recordUserBlock({
      turnId,
      agentName: body.name,
      text: body.prompt,
      source: "agent_spawn",
    });
  } catch (err) {
    logger.log("warn", "chat.turn.user-block.error", {
      agent: body.name,
      source: "agent_spawn",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  dispatchTurn({
    agentName: body.name,
    options: {
      agentName: body.name,
      agentType: body.type,
      workingDirectory,
      systemPrompt: spawnSystemPrompt,
      prompt: wrappedSpawnPrompt,
      turnId,
      model: body.model ?? modelCfg.name,
      thinking: modelCfg.thinking,
      effort: modelCfg.effort,
      daemonPort: resolveDaemonPort(cfg),
      parentName: body.parentName,
      mode: "long-lived",
    },
  });
  return { status: 201, body: { name: body.name, turn_id: turnId } };
}

function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ReturnType<typeof loadConfig>,
): void {
  // Phase 5: per-agent SSE channel. `?agent=<name>` restricts the
  // stream to live-turn events for that agent only. The dashboard
  // re-opens the connection on agent focus switch; events without an
  // `agent` field (e.g. connection_established, app_lifecycle) pass
  // through regardless so global daemon-level signals still reach the
  // client. Omitting the query string keeps the legacy global stream
  // for non-Zero callers + tests.
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const agentFilter = url.searchParams.get("agent");

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  // Flush headers + an SSE comment immediately so the browser's EventSource
  // transitions to OPEN right away (rather than waiting for the first event
  // or keepalive, which can be 20s+ on a quiet daemon).
  res.flushHeaders();
  res.write(": connected\n\n");

  // First event on every new connection: connection_established carries the
  // daemon's boot_id (FIX_FORWARD 1.6). Clients cache it and reset their
  // per-agent cursors on mismatch — the canonical signal of a daemon
  // restart. We do NOT advance the bus seq for this event; it carries a
  // sentinel seq=0 since clients should never use it for replay cursoring.
  writeRawEvent(res, {
    v: 1,
    seq: 0,
    type: "connection_established",
    boot_id: getBootId(),
    boot_ts: getBootTs(),
    current_seq: eventBus.currentSeq(),
    ts: Date.now(),
  });

  // Replay strategy (FIX_FORWARD 1.9):
  //   - With Last-Event-ID: replay strictly newer events. The browser sets
  //     this header automatically across EventSource reconnects, so a
  //     transient blip resumes seamlessly.
  //   - Without Last-Event-ID (fresh page load): walk back 500 events from
  //     the current head so any in-flight block_start/block_delta the
  //     client missed is delivered. The chat-side per-agent dedup
  //     (FIX_FORWARD 1.7) handles duplicates against the canonical-blocks
  //     fetch that the client also issues on mount.
  //
  // Phase 5: when `?agent=<name>` is set, the daemon switches from
  // the legacy seq-cursor replay to a "replay the current turn's
  // buffer" model (plan §211). The per-agent buffer is bounded
  // (2000 events) and evicted on `turn_done`, so the replay is
  // always scoped to the in-flight turn — no Last-Event-ID needed.
  if (agentFilter) {
    for (const e of eventBus.replayForAgent(agentFilter)) {
      if (!passesAgentFilter(e, agentFilter)) continue;
      writeEvent(res, e);
    }
  } else {
    const lastEventIdHeader = req.headers["last-event-id"];
    const parsedLast = lastEventIdHeader ? Number(lastEventIdHeader) : NaN;
    const BACKWALK = 500;
    const replayFrom =
      Number.isFinite(parsedLast) && parsedLast >= 0
        ? (parsedLast as number)
        : Math.max(0, eventBus.currentSeq() - BACKWALK);
    for (const e of eventBus.replaySince(replayFrom)) {
      writeEvent(res, e);
    }
  }

  const unsub = eventBus.subscribe((e) => {
    if (!passesAgentFilter(e, agentFilter)) return;
    writeEvent(res, e);
  });
  const ka = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      // socket closed
    }
  }, cfg.sseKeepaliveSec * 1000);

  req.on("close", () => {
    clearInterval(ka);
    unsub();
  });
}

/**
 * Phase 5 per-agent SSE filter. When `?agent=` is set, drop events
 * whose `agent` field doesn't match. Events without an `agent` field
 * (connection_established, app_lifecycle) always pass through — they're
 * daemon-level signals every connected client needs to see.
 */
function passesAgentFilter(
  e: { type?: unknown; agent?: unknown },
  agentFilter: string | null,
): boolean {
  if (!agentFilter) return true;
  if (typeof e.agent !== "string") return true;
  return e.agent === agentFilter;
}

function writeEvent(res: ServerResponse, e: { type: string; seq: number }): void {
  try {
    res.write(`id: ${e.seq}\n`);
    res.write(`event: ${e.type}\n`);
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  } catch {
    // socket closed
  }
}

/**
 * Write an SSE event that is NOT in the ring buffer — used for the
 * connection-handshake `connection_established` event. We skip the `id:`
 * line so the browser's `Last-Event-ID` cursor doesn't advance to seq=0,
 * which would defeat replay on the next reconnect.
 */
function writeRawEvent(res: ServerResponse, e: { type: string; [k: string]: unknown }): void {
  try {
    res.write(`event: ${e.type}\n`);
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  } catch {
    // socket closed
  }
}

async function handleSystemCommand(
  res: ServerResponse,
  body: { command: string; args?: string },
  cfg: ReturnType<typeof loadConfig>,
): Promise<void> {
  const args = (body.args ?? "").trim();
  switch (body.command) {
    case "archive": {
      if (!args) return json(res, 400, { error: "agent name required" });
      // Slash-command archive defaults to "abandoned" — the user didn't
      // signal outcome on the command line. The REST endpoint and MCP tool
      // require an explicit reason; this is the admin/CLI shortcut surface.
      void archiveAgent(args, { reason: "abandoned" });
      return json(res, 200, { ok: true, message: `archived ${args}` });
    }
    case "status": {
      return json(res, 200, {
        agents: await registry.listAgents(),
        ts: Date.now(),
      });
    }
    case "inspect": {
      if (!args) return json(res, 400, { error: "agent name required" });
      const a = await registry.getAgent(args);
      if (!a) return json(res, 404, { error: "agent not found" });
      return json(res, 200, a);
    }
    case "clear": {
      const cfg = loadConfig();
      const name = args || cfg.orchestratorName;
      const a = await registry.getAgent(name);
      if (!a) return json(res, 404, { error: `agent not found: ${name}` });
      // If a worker is currently running, tear it down so the next turn forks
      // a fresh process with no `resume` arg. setStatus + clearSession alone
      // wouldn't take effect until the worker exits naturally. Await the
      // refork before clearSession so the exit handler's setStatus(agent,
      // 'idle') reset can't race the session wipe.
      await forceWorkerRefork(name);
      await registry.clearSession(name);
      // Phase 5: `agent_lifecycle:refork` SSE retired — Zero replicates
      // the session-clear (agents.session_id=null) reactively.
      return json(res, 200, {
        ok: true,
        message: `clear: ${name} session cleared; next turn starts fresh`,
      });
    }
    case "scratch": {
      // `/scratch <topic>` — args is the seed topic, not the name. Names are
      // auto-generated as scratch-<adj>-<noun>, kebab-case + unique against
      // the live registry.
      const topic = args.trim();
      // Pre-fetch all existing agent names once so the name generator's
      // collision predicate stays sync (the loop tries random pairs).
      const existingNames = new Set((await registry.listAgents()).map((a) => a.name));
      const name = generateScratchName((n) => existingNames.has(n));
      await registry.registerAgent({
        name,
        type: "bare",
        parentName: undefined,
      });
      // Phase 5: `agent_lifecycle:spawn` SSE retired — Zero replicates
      // the agents INSERT to the dashboard sidebar reactively.

      // Seed the agent with the topic as its first user turn. Re-uses the
      // same dispatch path as /api/chat/turn so persistence + SSE work
      // identically, just bypasses the skill match (the topic is free text,
      // not a `/<skill>` invocation).
      if (topic) {
        const seedTurnId = `t_${randomUUID()}`;
        const modelCfg = resolveModelForRole(cfg, "bare");
        const { body: wrappedTopic, systemPrompt: scratchSystemPrompt } = await buildDispatchPrompt(
          { name, type: "bare" },
          { kind: "scratch", userText: topic },
        );
        // FRI-71: persist the seed topic as a user block so the bare agent's
        // first turn renders with the originating user bubble.
        try {
          await recordUserBlock({
            turnId: seedTurnId,
            agentName: name,
            text: topic,
            source: "scratch",
          });
        } catch (err) {
          logger.log("warn", "chat.turn.user-block.error", {
            agent: name,
            source: "scratch",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        dispatchTurn({
          agentName: name,
          options: {
            agentName: name,
            agentType: "bare",
            workingDirectory: process.cwd(),
            systemPrompt: scratchSystemPrompt,
            prompt: wrappedTopic,
            turnId: seedTurnId,
            model: modelCfg.name,
            thinking: modelCfg.thinking,
            effort: modelCfg.effort,
            resumeSessionId: undefined,
            daemonPort: resolveDaemonPort(cfg),
            parentName: undefined,
            mode: "long-lived",
          },
        });
      }

      return json(res, 200, { ok: true, agent: name });
    }
    case "restart": {
      // We rely on the process supervisor (tmux via `friday start`, or a
      // launchd / systemd unit per docs/run/) to respawn us. SIGTERM-then-let-
      // supervisor-restart is correct for any of those; a daemon launched
      // bare (no supervisor) will simply exit.
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
      return json(res, 200, { ok: true });
    }
    default:
      return json(res, 404, { error: `unknown system command: ${body.command}` });
  }
}

/**
 * Render a proposal as a ticket body. Includes signals as a brief evidence
 * appendix so the resulting ticket carries enough context to act on without
 * cross-referencing the proposal file.
 */
function renderProposalForTicket(p: Proposal): string {
  const sections = [p.proposedChange.trim()];
  if (p.signals.length > 0) {
    const lines = p.signals.map(
      (s) => `- \`${s.source}/${s.key}\` (${s.severity}, count=${s.count})`,
    );
    sections.push(`## Evidence\n\n${lines.join("\n")}`);
  }
  sections.push(
    `*Applied from evolve proposal \`${p.id}\` (${p.type}, blast: ${p.blastRadius}, score: ${p.score}).*`,
  );
  return sections.join("\n\n");
}

/**
 * Memory id slugifier. ASCII-only, lowercase, dashes for whitespace, dedup
 * runs of dashes, trim leading/trailing dashes. Not collision-resistant —
 * memory_save lets the caller pass an explicit id when that matters.
 */
function slugifyMemoryId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw) as T;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Parse an integer-shaped query param. Returns `undefined` if absent or NaN. */
function numericParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Allowlist of MIME types we accept for new uploads. Mirrors the dashboard's
 * file-picker `accept` attribute so the contract is consistent end-to-end.
 * The picker is a UI hint only — drag-drop and paste can deliver other
 * types — so the server enforces the same set.
 */
const ATTACHMENT_MIME_ALLOWLIST = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

/**
 * Subset of allowed MIMEs that are safe to serve inline (rendered by the
 * browser in-place). Anything outside this set is forced to download via
 * `Content-Disposition: attachment`. Conservative: even for a closed-loop
 * single-user daemon, we don't want the upload route to ever serve content
 * that could execute as script on the daemon's origin.
 */
const INLINE_SERVE_MIME_ALLOWLIST = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

/**
 * Same-host authorization for write/read endpoints. Two layers of defense:
 *
 *  1. Shared secret on `x-friday-daemon-secret` (defeats other local
 *     processes that haven't read `~/.friday/.daemon-secret`).
 *  2. Host header must be a loopback name (defeats DNS-rebind: a hostile
 *     page resolving `attacker.example` to 127.0.0.1 will send
 *     `Host: attacker.example` and fail this check).
 */
function authorizeSameHost(req: IncomingMessage): boolean {
  if (!isLocalHost(req.headers.host)) return false;
  const provided = req.headers[DAEMON_SECRET_HEADER];
  if (typeof provided !== "string") return false;
  // Constant-time comparison to avoid timing oracles. The secret is short
  // enough that the loop cost is negligible.
  const expected = getDaemonSecret();
  if (provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Render a filename for `Content-Disposition`. Returns both an ASCII
 * fallback (for legacy clients) and an RFC 5987 percent-encoded form. We
 * strip control chars and double quotes, replace path separators, and cap
 * the length so the header never carries unbounded user input.
 */
function sanitizeFilenameForHeader(raw: string): {
  ascii: string;
  rfc5987: string;
} {
  // Strip path separators, control chars, and quotes that would break the
  // ASCII `filename="..."` form.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x1f\x7f"\\/]/g, "_").slice(0, 200);
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, "_") || "attachment";
  const rfc5987 = encodeURIComponent(cleaned).replace(/['()]/g, escape);
  return { ascii, rfc5987 };
}
