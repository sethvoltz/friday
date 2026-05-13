import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { logger } from "../log.js";
import { eventBus, getBootId, getBootTs } from "../events/bus.js";
import {
  type AgentEntry,
  DAEMON_SECRET_HEADER,
  getDaemonSecret,
  isLocalHost,
  loadConfig,
  composeSystemPrompt,
  loadSkills,
  normalizeModelConfig,
  readPromptStack,
  skillsForAgent,
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
import { wrapWithRecall } from "../agent/recall.js";
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
  sinceHoursAgo,
  appendRun,
  updateProposal,
  type Proposal,
  type SaveProposalInput,
  type UpdateProposalInput,
} from "@friday/evolve";
import {
  importIssue as linearImportIssue,
  reconcile as linearReconcile,
} from "@friday/integrations-linear";
import {
  deleteSchedule,
  getSchedule,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  triggerSchedule,
  upsertSchedule,
} from "../scheduler/scheduler.js";
import {
  readScheduleArtifacts,
} from "../scheduler/state.js";
import * as registry from "../agent/registry.js";
import {
  abortTurn,
  dispatchTurn,
  killAgent,
  peekLiveWorker,
  recordUserBlock,
} from "../agent/lifecycle.js";
import { generateScratchName } from "../agent/scratch-names.js";
import {
  createWorkspace,
  destroyWorkspace,
  workspacePath,
} from "../agent/workspace.js";
import { commandsApi } from "./commands.js";
import { randomUUID } from "node:crypto";
import { isValidAgentName } from "@friday/shared";
import type { AgentType } from "@friday/shared";

export interface StartServerOptions {
  port: number;
}

interface PostTurnBody {
  text: string;
  agent?: string;
  attachments?: Array<{ sha256: string; filename: string; mime: string }>;
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

  // --- Health ---
  if (method === "GET" && path === "/api/health") {
    // FIX_FORWARD 5.8: gate /api/health behind the same-host secret so a
    // local web page (or a DNS-rebind attacker) can't probe daemon status
    // without first reading ~/.friday/.daemon-secret.
    if (!authorizeSameHost(req)) {
      return json(res, 401, { error: "unauthorized" });
    }
    return json(res, 200, { ok: true, ts: Date.now() });
  }

  // --- Commands (system + skills, for chat autocomplete) ---
  if (method === "GET" && path === "/api/commands") {
    return json(res, 200, commandsApi());
  }

  // --- System command dispatch ---
  if (method === "POST" && path === "/api/commands/dispatch") {
    const body = await readJson<{ command: string; args?: string }>(req);
    return handleSystemCommand(res, body, cfg);
  }

  // --- SSE events ---
  if (method === "GET" && path === "/api/events") {
    return handleEvents(req, res, cfg);
  }

  // --- Chat turn ---
  if (method === "POST" && path === "/api/chat/turn") {
    const body = await readJson<PostTurnBody>(req);
    const agentName = body.agent ?? cfg.orchestratorName;
    const turnId = `t_${randomUUID()}`;

    // Ensure orchestrator exists.
    if (!registry.getAgent(agentName)) {
      registry.registerAgent({ name: agentName, type: "orchestrator" });
    }

    const agentRow = registry.getAgent(agentName)!;
    const resumeSessionId = agentRow.sessionId ?? undefined;

    const stack = readPromptStack(agentRow.type, []);
    const baseSystemPrompt = composeSystemPrompt(stack);

    // Skill detection: if the user typed `/<name> <args>`, look up the skill
    // and inject its body as a per-turn `<skill-context>` block. The user
    // message becomes the args portion; if the skill restricts allowedTools,
    // that restriction applies for this turn only.
    const skillMatch = matchSkillInvocation(body.text, agentRow.type);
    const userText = skillMatch ? skillMatch.userText : body.text;
    const systemPrompt = skillMatch
      ? `${baseSystemPrompt}\n\n<skill-context name="${skillMatch.skill.name}">\n${skillMatch.skill.body}\n</skill-context>`
      : baseSystemPrompt;
    const allowedToolsOverride = skillMatch?.skill.allowedTools ?? undefined;

    const wrappedPrompt = wrapWithRecall(userText, userText, "user_chat");

    // Persist the user's typed prompt as a `role='user'`, `source='user_chat'`
    // block before dispatching. Stays scoped to the user's literal input —
    // recall-block / skill scaffolding is internal and not part of the
    // user-visible message stream (FIX_FORWARD 1.2).
    try {
      recordUserBlock({
        turnId,
        agentName,
        sessionId: resumeSessionId,
        text: body.text,
        source: "user_chat",
      });
    } catch (err) {
      logger.log("warn", "chat.turn.user-block.error", {
        agent: agentName,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const modelCfg = normalizeModelConfig(cfg.model);
    dispatchTurn({
      agentName,
      options: {
        agentName,
        agentType: agentRow.type,
        workingDirectory: registry.workingDirectoryFor(agentRow),
        systemPrompt,
        prompt: wrappedPrompt,
        turnId,
        model: modelCfg.name,
        thinking: modelCfg.thinking,
        effort: modelCfg.effort,
        resumeSessionId,
        daemonPort: cfg.daemonPort,
        parentName:
          "parentName" in agentRow
            ? agentRow.parentName ?? undefined
            : undefined,
        mode: agentRow.type === "scheduled" ? "one-shot" : "long-lived",
        allowedToolsOverride,
      },
    });
    return json(res, 200, { turn_id: turnId });
  }

  if (method === "POST" && path.startsWith("/api/chat/turn/") && path.endsWith("/abort")) {
    const turnId = path.split("/")[4];
    // Find the agent owning this turn (Phase 2: orchestrator-only, so just abort).
    let aborted = false;
    for (const a of registry.listAgents()) {
      if (abortTurn(a.name)) aborted = true;
    }
    return json(res, 200, { aborted, turn_id: turnId });
  }

  // --- Agents ---
  if (method === "GET" && path === "/api/agents") {
    const all: AgentEntry[] = registry.listAgents();
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
      (a) =>
        (!typeFilter || a.type === typeFilter) &&
        (!statusFilter || a.status === statusFilter),
    );
    // Augment with past-session count so the dashboard sidebar can decide
    // whether an agent has expandable history without N+1 follow-up calls.
    const counts = sessionCountsByAgent();
    const augmented = filtered.map((a) => ({
      ...a,
      sessionCount: counts[a.name] ?? 0,
    }));
    return json(res, 200, augmented);
  }
  if (method === "GET" && /^\/api\/agents\/[^/]+\/sessions$/.test(path)) {
    const agentName = path.split("/")[3];
    return json(res, 200, listAgentSessions(agentName));
  }
  if (method === "POST" && path === "/api/agents") {
    const body = await readJson<{
      type: AgentType;
      name: string;
      parentName: string;
      prompt: string;
      model?: string;
      ticketId?: string;
      worktree?: { repo: string; branch?: string };
    }>(req);
    if (!body.name || !isValidAgentName(body.name)) {
      return json(res, 400, {
        error:
          "invalid name (must be lowercase alphanumeric + dashes, up to 64 chars)",
      });
    }
    if (registry.getAgent(body.name)) {
      return json(res, 409, { error: `agent "${body.name}" already exists` });
    }
    if (
      body.type !== "builder" &&
      body.type !== "helper" &&
      body.type !== "bare"
    ) {
      return json(res, 400, {
        error: `cannot create agent of type "${body.type}" via this endpoint`,
      });
    }

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
        });
        workingDirectory = ws.path;
        worktreePath = ws.path;
      } catch (err) {
        return json(res, 500, {
          error: `workspace creation failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    registry.registerAgent({
      name: body.name,
      type: body.type,
      parentName: body.parentName,
      ticketId: body.ticketId,
      worktreePath,
      branch,
    });

    const turnId = `t_${randomUUID()}`;
    const stack = readPromptStack(body.type, []);
    const baseSystemPrompt = composeSystemPrompt(stack);
    const systemPrompt =
      body.type === "builder" && worktreePath
        ? `${baseSystemPrompt}\n\n---\n\nYou are running in a git worktree at \`${worktreePath}\` on branch \`${branch}\`. **Do not read, write, or modify files outside this directory.** All Bash commands run with this directory as cwd by default; do not \`cd\` outside it.`
        : baseSystemPrompt;
    const modelCfg = normalizeModelConfig(cfg.model);
    const wrappedSpawnPrompt = wrapWithRecall(
      body.prompt,
      body.prompt,
      "agent_spawn",
    );
    dispatchTurn({
      agentName: body.name,
      options: {
        agentName: body.name,
        agentType: body.type,
        workingDirectory,
        systemPrompt,
        prompt: wrappedSpawnPrompt,
        turnId,
        model: body.model ?? modelCfg.name,
        thinking: modelCfg.thinking,
        effort: modelCfg.effort,
        daemonPort: cfg.daemonPort,
        parentName: body.parentName,
        mode: "long-lived",
      },
    });
    return json(res, 201, { name: body.name, turn_id: turnId });
  }
  if (
    method === "DELETE" &&
    /^\/api\/agents\/[^/]+\/workspace$/.test(path)
  ) {
    const name = path.split("/")[3];
    const a = registry.getAgent(name);
    if (!a) return json(res, 404, { error: "not found" });
    if (a.type !== "builder")
      return json(res, 400, {
        error: "agent is not a builder; no workspace to clean up",
      });
    // FIX_FORWARD 6.4 follow-up: refuse to nuke a live worker's worktree
    // from under it. Caller must kill the agent first (or the agent must
    // have crashed itself into `error`). Allow `error` because that
    // state indicates the worker is gone.
    if (a.status !== "killed" && a.status !== "error") {
      return json(res, 409, {
        error: `agent ${name} is ${a.status}; kill it before deleting the workspace`,
      });
    }
    const repo = process.cwd();
    try {
      // PF-2: pass the branch so destroyWorkspace also force-deletes the
      // friday/<name> branch from the parent repo. The work has either
      // been merged (PR landed) or is being explicitly thrown away.
      const branch =
        a.type === "builder" && "branch" in a ? a.branch : undefined;
      destroyWorkspace(name, repo, { branch });
      return json(res, 200, { ok: true, path: workspacePath(name) });
    } catch (err) {
      return json(res, 500, {
        error: `workspace cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  if (method === "GET" && /^\/api\/agents\/[^/]+$/.test(path)) {
    const name = path.split("/")[3];
    const a = registry.getAgent(name);
    if (!a) return json(res, 404, { error: "not found" });
    return json(res, 200, a);
  }
  if (method === "POST" && /^\/api\/agents\/[^/]+\/kill$/.test(path)) {
    const name = path.split("/")[3];
    killAgent(name);
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
      const result = fetchBlocksByAgent({
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
        last_event_seq: result.lastEventSeq,
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
    const TICKET_STATUSES = [
      "open",
      "in_progress",
      "done",
      "blocked",
      "closed",
    ] as const;
    const rawStatus = url.searchParams.get("status");
    const status = (TICKET_STATUSES as readonly string[]).includes(
      rawStatus ?? "",
    )
      ? (rawStatus as (typeof TICKET_STATUSES)[number])
      : undefined;
    const assignee = url.searchParams.get("assignee") ?? undefined;
    return json(res, 200, listTickets({ status, assignee }));
  }
  if (method === "POST" && path === "/api/tickets") {
    const body = await readJson<Parameters<typeof createTicket>[0]>(req);
    return json(res, 200, createTicket(body));
  }
  if (method === "GET" && /^\/api\/tickets\/[^/]+$/.test(path)) {
    const id = path.split("/")[3];
    const t = getTicket(id);
    if (!t) return json(res, 404, { error: "not found" });
    const ext = externalLinks(id);
    const comments = listComments(id);
    return json(res, 200, { ...t, externalLinks: ext, comments });
  }
  if (method === "PATCH" && /^\/api\/tickets\/[^/]+$/.test(path)) {
    const id = path.split("/")[3];
    const body = await readJson<Parameters<typeof updateTicket>[1]>(req);
    return json(res, 200, updateTicket(id, body));
  }
  if (method === "POST" && /^\/api\/tickets\/[^/]+\/comments$/.test(path)) {
    const id = path.split("/")[3];
    const body = await readJson<{ author: string; body: string }>(req);
    addComment(id, body.author, body.body);
    return json(res, 200, { ok: true });
  }
  if (method === "POST" && /^\/api\/tickets\/[^/]+\/links$/.test(path)) {
    const id = path.split("/")[3];
    if (!getTicket(id)) return json(res, 404, { error: "ticket not found" });
    const body = await readJson<{
      system: string;
      externalId: string;
      url?: string;
      meta?: Record<string, unknown>;
    }>(req);
    if (!body.system || !body.externalId) {
      return json(res, 400, { error: "system and externalId required" });
    }
    linkExternal({
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
    if (!getTicket(id)) return json(res, 404, { error: "ticket not found" });
    const system = url.searchParams.get("system");
    const externalId = url.searchParams.get("externalId");
    if (!system || !externalId) {
      return json(res, 400, {
        error: "system and externalId query params required",
      });
    }
    const removed = unlinkExternal({ ticketId: id, system, externalId });
    if (!removed) return json(res, 404, { error: "link not found" });
    return json(res, 200, { ok: true });
  }

  // --- Schedules ---
  if (method === "GET" && path === "/api/schedules") {
    return json(res, 200, listSchedules());
  }
  if (method === "POST" && path === "/api/schedules") {
    const body = await readJson<Parameters<typeof upsertSchedule>[0]>(req);
    upsertSchedule(body);
    return json(res, 200, { ok: true });
  }
  if (
    method === "POST" &&
    /^\/api\/schedules\/[^/]+\/trigger$/.test(path)
  ) {
    const name = decodeURIComponent(path.split("/")[3]);
    const runId = triggerSchedule(name);
    if (!runId)
      return json(res, 409, {
        error: "schedule not found or already running",
      });
    return json(res, 200, { runId });
  }
  if (
    method === "POST" &&
    /^\/api\/schedules\/[^/]+\/(pause|resume)$/.test(path)
  ) {
    const name = decodeURIComponent(path.split("/")[3]);
    const action = path.split("/")[4];
    const ok =
      action === "pause" ? pauseSchedule(name) : resumeSchedule(name);
    if (!ok) return json(res, 404, { error: "schedule not found" });
    return json(res, 200, { ok: true });
  }
  if (method === "GET" && /^\/api\/schedules\/[^/]+$/.test(path)) {
    const name = decodeURIComponent(path.split("/")[3]);
    const r = getSchedule(name);
    if (!r) return json(res, 404, { error: "schedule not found" });
    return json(res, 200, r);
  }
  if (method === "GET" && /^\/api\/schedules\/[^/]+\/state$/.test(path)) {
    const name = decodeURIComponent(path.split("/")[3]);
    if (!getSchedule(name))
      return json(res, 404, { error: "schedule not found" });
    return json(res, 200, readScheduleArtifacts(name));
  }
  if (method === "DELETE" && /^\/api\/schedules\/[^/]+$/.test(path)) {
    const name = decodeURIComponent(path.split("/")[3]);
    const ok = deleteSchedule(name);
    if (!ok) return json(res, 404, { error: "schedule not found" });
    return json(res, 200, { ok: true });
  }

  // --- Memory ---
  if (method === "GET" && path === "/api/memory") {
    return json(res, 200, listEntries());
  }
  if (method === "GET" && path === "/api/memory/search") {
    const q = url.searchParams.get("q") ?? "";
    const tagsParam = url.searchParams.get("tags");
    const limitParam = url.searchParams.get("limit");
    const tags = tagsParam
      ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;
    const limit = limitParam ? Math.max(1, Number(limitParam) || 10) : undefined;
    if (!q.trim()) return json(res, 400, { error: "q parameter required" });
    const results = searchMemories({
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
    const callerName = String(
      req.headers["x-friday-caller-name"] ?? "user",
    );
    const now = new Date().toISOString();
    const existing = getEntry(id);
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
    saveEntry(entry);
    return json(res, existing ? 200 : 201, entry);
  }
  if (method === "GET" && /^\/api\/memory\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[3]);
    const e = getEntry(id);
    if (!e) return json(res, 404, { error: "not found" });
    // FIX_FORWARD 6.8 follow-up: bumping `recallCount` on every dashboard
    // page view (load, edit, delete, invalidateAll) pollutes the metric
    // that's supposed to reflect agent-side recall frequency. Require an
    // explicit `?recall=1` from callers that want the bump (the
    // auto-recall block uses `searchMemories`, which touches on its own).
    if (url.searchParams.get("recall") === "1") {
      touchRecall(id);
    }
    return json(res, 200, e);
  }
  if (method === "PATCH" && /^\/api\/memory\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[3]);
    if (!getEntry(id)) return json(res, 404, { error: "not found" });
    const patch = await readJson<{
      title?: string;
      content?: string;
      tags?: string[];
    }>(req);
    updateEntry(id, patch);
    return json(res, 200, getEntry(id));
  }
  if (method === "DELETE" && /^\/api\/memory\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[3]);
    if (!getEntry(id)) return json(res, 404, { error: "not found" });
    forgetEntry(id);
    return json(res, 200, { ok: true });
  }

  // --- Evolve ---
  if (method === "GET" && path === "/api/evolve/proposals") {
    const all = listProposals();
    const statusFilter = url.searchParams.get("status");
    const typeFilter = url.searchParams.get("type");
    const filtered = all.filter(
      (p) =>
        (!statusFilter || p.status === statusFilter) &&
        (!typeFilter || p.type === typeFilter),
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
    return json(res, 201, p);
  }
  if (
    method === "GET" &&
    /^\/api\/evolve\/proposals\/[^/]+$/.test(path)
  ) {
    const id = decodeURIComponent(path.split("/")[4]);
    const p = getProposal(id);
    if (!p) return json(res, 404, { error: "proposal not found" });
    return json(res, 200, p);
  }
  if (
    method === "PATCH" &&
    /^\/api\/evolve\/proposals\/[^/]+$/.test(path)
  ) {
    const id = decodeURIComponent(path.split("/")[4]);
    if (!getProposal(id))
      return json(res, 404, { error: "proposal not found" });
    const patch = await readJson<UpdateProposalInput>(req);
    const next = updateProposal(id, patch);
    return json(res, 200, next);
  }
  if (
    method === "DELETE" &&
    /^\/api\/evolve\/proposals\/[^/]+$/.test(path)
  ) {
    const id = decodeURIComponent(path.split("/")[4]);
    if (!deleteProposal(id))
      return json(res, 404, { error: "proposal not found" });
    return json(res, 200, { ok: true });
  }
  if (
    method === "POST" &&
    /^\/api\/evolve\/proposals\/[^/]+\/apply$/.test(path)
  ) {
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
    const ticket = createTicket({
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
    return json(res, 200, { proposal: updated, ticket });
  }
  if (
    method === "POST" &&
    /^\/api\/evolve\/proposals\/[^/]+\/dismiss$/.test(path)
  ) {
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
    return json(res, 200, updated);
  }

  if (method === "POST" && path === "/api/evolve/scan") {
    const body = await readJson<{
      windowHours?: number;
      includeFriction?: boolean;
    }>(req);
    const windowHours = body.windowHours ?? 24;
    const includeFriction = body.includeFriction !== false;
    const callerName = String(req.headers["x-friday-caller-name"] ?? "scan");
    const since = sinceHoursAgo(windowHours);
    const windowEnd = new Date().toISOString();
    try {
      const syncSignals = scanAll({ since });
      const frictionSignals = includeFriction
        ? await scanFriction({ since }).catch((err) => {
            logger.log("warn", "evolve.scan.friction-error", {
              message: err instanceof Error ? err.message : String(err),
            });
            return [] as typeof syncSignals;
          })
        : [];
      const signals = [...syncSignals, ...frictionSignals];
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
      return json(res, 200, {
        signals: signals.length,
        created: propose.created.length,
        updated: propose.updated.length,
        promotedToCritical: propose.promotedToCritical.length,
        reranked: reranked.reranked.length,
        promotedFromRerank: reranked.promoted.length,
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
  if (method === "POST" && path === "/api/integrations/linear/reconcile") {
    try {
      const result = await linearReconcile();
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
    return json(res, 200, inbox(agent));
  }
  if (method === "POST" && path === "/api/mail/send") {
    const body = await readJson<Parameters<typeof sendMail>[0]>(req);
    // FIX_FORWARD 5.7: per-agent mail rate limit — 50 mails / 5min / from.
    // A runaway tool that spams the orchestrator can't drown the mail bus.
    const fromAgent = body.fromAgent || "__unknown__";
    const r = consumeRateLimit({
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
    return json(res, 200, sendMail(body));
  }
  if (method === "POST" && /^\/api\/mail\/\d+\/read$/.test(path)) {
    const id = Number(path.split("/")[3]);
    const row = getMail(id);
    if (!row) return json(res, 404, { error: "mail not found" });
    markRead(id);
    return json(res, 200, { ...row, delivery: "read", readAt: Date.now() });
  }
  if (method === "POST" && /^\/api\/mail\/\d+\/close$/.test(path)) {
    const id = Number(path.split("/")[3]);
    const row = getMail(id);
    if (!row) return json(res, 404, { error: "mail not found" });
    closeMail(id);
    return json(res, 200, { ok: true });
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
    const bytes = readAttachmentBytes(sha);
    if (!bytes) return json(res, 404, { error: "not found" });
    const meta = getAttachment(sha);
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
      headers["content-disposition"] = `attachment; filename="${safeFilename.ascii}"; filename*=UTF-8''${safeFilename.rfc5987}`;
    }
    res.writeHead(200, headers);
    res.end(bytes);
    return;
  }

  return json(res, 404, { error: "not found", path });
}

function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ReturnType<typeof loadConfig>,
): void {
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

  const unsub = eventBus.subscribe((e) => writeEvent(res, e));
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
function writeRawEvent(
  res: ServerResponse,
  e: { type: string; [k: string]: unknown },
): void {
  try {
    res.write(`event: ${e.type}\n`);
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  } catch {
    // socket closed
  }
}

function handleSystemCommand(
  res: ServerResponse,
  body: { command: string; args?: string },
  cfg: ReturnType<typeof loadConfig>,
): void {
  const args = (body.args ?? "").trim();
  switch (body.command) {
    case "kill": {
      if (!args) return json(res, 400, { error: "agent name required" });
      killAgent(args);
      return json(res, 200, { ok: true, message: `killed ${args}` });
    }
    case "status": {
      return json(res, 200, {
        agents: registry.listAgents(),
        ts: Date.now(),
      });
    }
    case "inspect": {
      if (!args) return json(res, 400, { error: "agent name required" });
      const a = registry.getAgent(args);
      if (!a) return json(res, 404, { error: "agent not found" });
      return json(res, 200, a);
    }
    case "reset-context": {
      const cfg = loadConfig();
      const name = args || cfg.orchestratorName;
      const a = registry.getAgent(name);
      if (!a) return json(res, 404, { error: `agent not found: ${name}` });
      // If a worker is currently running, stop it so the next turn forks a
      // fresh process with no `resume` arg. setStatus + clearSession alone
      // wouldn't take effect until the worker exits naturally.
      killAgent(name);
      registry.clearSession(name);
      eventBus.publish({
        v: 1,
        type: "agent_lifecycle",
        agent: name,
        agentType: a.type,
        event: "refork",
        reason: "reset-context",
      });
      return json(res, 200, {
        ok: true,
        message: `reset-context: ${name} session cleared; next turn starts fresh`,
      });
    }
    case "scratch": {
      // `/scratch <topic>` — args is the seed topic, not the name. Names are
      // auto-generated as scratch-<adj>-<noun>, kebab-case + unique against
      // the live registry.
      const topic = args.trim();
      const name = generateScratchName((n) => registry.getAgent(n) !== null);
      registry.registerAgent({
        name,
        type: "bare",
        parentName: undefined,
      });
      eventBus.publish({
        v: 1,
        type: "agent_lifecycle",
        agent: name,
        agentType: "bare",
        event: "spawn",
      });

      // Seed the agent with the topic as its first user turn. Re-uses the
      // same dispatch path as /api/chat/turn so persistence + SSE work
      // identically, just bypasses the skill match (the topic is free text,
      // not a `/<skill>` invocation).
      if (topic) {
        const seedTurnId = `t_${randomUUID()}`;
        const stack = readPromptStack("bare", []);
        const systemPrompt = composeSystemPrompt(stack);
        const modelCfg = normalizeModelConfig(cfg.model);
        const wrappedTopic = wrapWithRecall(topic, topic, "scratch");
        dispatchTurn({
          agentName: name,
          options: {
            agentName: name,
            agentType: "bare",
            workingDirectory: process.cwd(),
            systemPrompt,
            prompt: wrappedTopic,
            turnId: seedTurnId,
            model: modelCfg.name,
            thinking: modelCfg.thinking,
            effort: modelCfg.effort,
            resumeSessionId: undefined,
            daemonPort: cfg.daemonPort,
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
 * Detect a `/<skill-name> ...args` invocation at the start of a user message.
 * Returns the matched Skill plus the remaining args (the user message minus
 * the slash command), or null if no match. Filters by agent type.
 */
function matchSkillInvocation(
  text: string,
  agentType: AgentEntry["type"],
): { skill: ReturnType<typeof loadSkills>[number]; userText: string } | null {
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const name = m[1];
  const rest = (m[2] ?? "").trim();
  const all = loadSkills();
  const eligible = skillsForAgent(all, agentType);
  const skill = eligible.find((s) => s.name === name);
  if (!skill) return null;
  return { skill, userText: rest };
}

/**
 * Render a proposal as a ticket body. Includes signals as a brief evidence
 * appendix so the resulting ticket carries enough context to act on without
 * cross-referencing the proposal file.
 */
function renderProposalForTicket(p: Proposal): string {
  const sections = [p.proposedChange.trim()];
  if (p.signals.length > 0) {
    const lines = p.signals.map((s) =>
      `- \`${s.source}/${s.key}\` (${s.severity}, count=${s.count})`,
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
  const ascii =
    cleaned.replace(/[^\x20-\x7e]/g, "_") || "attachment";
  const rfc5987 = encodeURIComponent(cleaned).replace(/['()]/g, escape);
  return { ascii, rfc5987 };
}
