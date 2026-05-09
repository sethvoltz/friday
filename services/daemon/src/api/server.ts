import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { logger } from "../log.js";
import { eventBus } from "../events/bus.js";
import {
  type AgentEntry,
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
  createTicket,
  externalLinks,
  getMail,
  getTicket,
  inbox,
  linkExternal,
  listAgentSessions,
  listComments,
  listTickets,
  listTurns,
  markRead,
  sendMail,
  sessionCountsByAgent,
  updateTicket,
} from "@friday/shared/services";
import {
  buildAutoRecallBlock,
  forgetEntry,
  getEntry,
  listEntries,
  saveEntry,
  searchMemories,
  touchRecall,
  updateEntry,
  type MemoryEntry,
} from "@friday/memory";
import {
  deleteProposal,
  getProposal,
  listProposals,
  saveProposal,
  updateProposal,
  type Proposal,
  type SaveProposalInput,
  type UpdateProposalInput,
} from "@friday/evolve";
import {
  deleteSchedule,
  getSchedule,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  triggerSchedule,
  upsertSchedule,
} from "../scheduler/scheduler.js";
import * as registry from "../agent/registry.js";
import {
  abortTurn,
  dispatchTurn,
  killAgent,
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
  server.listen(opts.port, "localhost");
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

    const recallBlock = safeRecall(userText);
    const wrappedPrompt = recallBlock
      ? `${recallBlock}\n\n${userText}`
      : userText;

    const modelCfg = normalizeModelConfig(cfg.model);
    dispatchTurn({
      agentName,
      options: {
        agentName,
        agentType: agentRow.type,
        workingDirectory: process.cwd(),
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
    const typeFilter = url.searchParams.get("type");
    const statusFilter = url.searchParams.get("status");
    const filtered = all.filter(
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
    dispatchTurn({
      agentName: body.name,
      options: {
        agentName: body.name,
        agentType: body.type,
        workingDirectory,
        systemPrompt,
        prompt: body.prompt,
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
    const repo = process.cwd();
    try {
      destroyWorkspace(name, repo);
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

  // --- Sessions / turns ---
  if (method === "GET" && /^\/api\/sessions\/[^/]+\/turns$/.test(path)) {
    const sessionId = path.split("/")[3];
    const turns = listTurns({ sessionId, limit: 100 });
    return json(res, 200, turns);
  }
  if (method === "GET" && /^\/api\/agents\/[^/]+\/turns$/.test(path)) {
    const agentName = path.split("/")[3];
    const limitParam = url.searchParams.get("limit");
    const beforeParam = url.searchParams.get("beforeId");
    // The orchestrator is a single persistent thread across the agent's
    // entire lifetime, regardless of how many internal SDK session_ids
    // accrued from resumes/restarts. Return all turns for the agent in
    // reverse-chronological order; the client paginates with `beforeId`
    // for older content. Memory + compaction handle long-term context.
    const turns = listTurns({
      agentName,
      limit: limitParam ? Number(limitParam) : 50,
      beforeId: beforeParam ? Number(beforeParam) : undefined,
    });
    return json(res, 200, turns);
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
    touchRecall(id);
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

  // --- Mail ---
  if (method === "GET" && /^\/api\/mail\/inbox\/[^/]+$/.test(path)) {
    const agent = path.split("/")[4];
    return json(res, 200, inbox(agent));
  }
  if (method === "POST" && path === "/api/mail/send") {
    const body = await readJson<Parameters<typeof sendMail>[0]>(req);
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

  // --- Chat reply (agents post user-facing messages) ---
  if (method === "POST" && path === "/api/chat/reply") {
    const body = await readJson<{
      from: string;
      fromType?: string;
      text: string;
      kind?: string;
    }>(req);
    const turnId = `t_${randomUUID()}`;
    const preview =
      body.text.length > 240 ? body.text.slice(0, 240) + "…" : body.text;
    eventBus.publish({
      v: 1,
      type: "agent_message",
      agent: body.from,
      turn_id: turnId,
      preview,
    });
    return json(res, 200, { ok: true, turn_id: turnId });
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

  // Replay since Last-Event-ID
  const lastEventIdHeader = req.headers["last-event-id"];
  const lastSeq = lastEventIdHeader ? Number(lastEventIdHeader) : 0;
  for (const e of eventBus.replaySince(lastSeq)) {
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
        dispatchTurn({
          agentName: name,
          options: {
            agentName: name,
            agentType: "bare",
            workingDirectory: process.cwd(),
            systemPrompt,
            prompt: topic,
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
    case "jump": {
      // Pure UI command — daemon has no role; included for completeness.
      return json(res, 200, { ok: true });
    }
    case "restart": {
      // Self-restart deferred to v1.x — exit and let tmux's process supervisor
      // restart us. For now, signal SIGTERM to ourselves.
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

/** Memory recall is best-effort; failures don't block the turn. */
function safeRecall(userText: string): string {
  try {
    return buildAutoRecallBlock(userText);
  } catch (err) {
    logger.log("warn", "memory.recall.error", {
      message: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
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
