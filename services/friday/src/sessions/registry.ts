import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  AGENTS_PATH,
  type AgentRegistry,
  type RegistryEntry,
  type AgentStatus,
  type BuilderEntry,
  type AgentEntry,
  type OrchestratorEntry,
  isValidAgentName,
} from "@friday/shared";
import { log } from "../log.js";

let registry: AgentRegistry = {};

export function loadRegistry(): void {
  if (existsSync(AGENTS_PATH)) {
    registry = JSON.parse(readFileSync(AGENTS_PATH, "utf-8"));
    log("info", "registry_loaded", {
      count: Object.keys(registry).length,
    });
  }
}

function saveRegistry(): void {
  writeFileSync(AGENTS_PATH, JSON.stringify(registry, null, 2));
}

export function getAgent(name: string): RegistryEntry | undefined {
  return registry[name];
}

export function listAgents(filter?: {
  type?: RegistryEntry["type"];
  status?: AgentStatus;
  parent?: string;
}): Array<{ name: string; entry: RegistryEntry }> {
  return Object.entries(registry)
    .filter(([, entry]) => {
      if (filter?.type && entry.type !== filter.type) return false;
      if (filter?.status && entry.status !== filter.status) return false;
      if (filter?.parent) {
        if (!("parent" in entry) || entry.parent !== filter.parent) return false;
      }
      return true;
    })
    .map(([name, entry]) => ({ name, entry }));
}

export function registerOrchestrator(): OrchestratorEntry {
  const existing = registry["orchestrator"];
  if (existing && existing.type === "orchestrator") {
    return existing;
  }

  const entry: OrchestratorEntry = {
    type: "orchestrator",
    sessionId: null,
    status: "active",
    createdAt: new Date().toISOString(),
    children: [],
  };
  registry["orchestrator"] = entry;
  saveRegistry();
  log("info", "agent_registered", { name: "orchestrator", type: "orchestrator" });
  return entry;
}

export function registerBuilder(
  name: string,
  parent: string,
  workspace: string,
  epicId: string | null
): BuilderEntry {
  if (!isValidAgentName(name)) {
    throw new Error(`Invalid agent name: "${name}"`);
  }
  if (registry[name]) {
    throw new Error(`Agent "${name}" already exists`);
  }

  const parentEntry = registry[parent];
  if (!parentEntry) {
    throw new Error(`Parent agent "${parent}" not found`);
  }
  if (parentEntry.type !== "orchestrator") {
    throw new Error(`Only the Orchestrator can create Builders`);
  }

  const entry: BuilderEntry = {
    type: "builder",
    parent,
    sessionId: null,
    status: "active",
    workspace,
    epicId,
    createdAt: new Date().toISOString(),
    children: [],
  };

  registry[name] = entry;
  if ("children" in parentEntry) {
    parentEntry.children.push(name);
  }
  saveRegistry();
  log("info", "agent_registered", { name, type: "builder", parent });
  return entry;
}

export function registerAgent(
  name: string,
  parent: string,
  taskId: string | null,
  cwd: string
): AgentEntry {
  if (!isValidAgentName(name)) {
    throw new Error(`Invalid agent name: "${name}"`);
  }
  if (registry[name]) {
    throw new Error(`Agent "${name}" already exists`);
  }

  const parentEntry = registry[parent];
  if (!parentEntry) {
    throw new Error(`Parent agent "${parent}" not found`);
  }
  if (parentEntry.type === "agent") {
    throw new Error(`Agents cannot create other Agents`);
  }

  const entry: AgentEntry = {
    type: "agent",
    parent,
    sessionId: null,
    status: "active",
    taskId,
    cwd,
    createdAt: new Date().toISOString(),
  };

  registry[name] = entry;
  if ("children" in parentEntry) {
    parentEntry.children.push(name);
  }
  saveRegistry();
  log("info", "agent_registered", { name, type: "agent", parent });
  return entry;
}

export function updateAgentSession(
  name: string,
  sessionId: string
): void {
  const entry = registry[name];
  if (!entry) {
    throw new Error(`Agent "${name}" not found`);
  }
  entry.sessionId = sessionId;
  saveRegistry();
}

export function updateAgentStatus(
  name: string,
  status: AgentStatus
): void {
  const entry = registry[name];
  if (!entry) {
    throw new Error(`Agent "${name}" not found`);
  }
  entry.status = status;
  saveRegistry();
}

export function destroyAgent(name: string): void {
  const entry = registry[name];
  if (!entry) {
    throw new Error(`Agent "${name}" not found`);
  }
  if (entry.type === "orchestrator") {
    throw new Error(`Cannot destroy the Orchestrator`);
  }

  // Recursively destroy children first
  if ("children" in entry) {
    for (const childName of [...entry.children]) {
      destroyAgent(childName);
    }
  }

  // Remove from parent's children list
  const parentEntry = registry[entry.parent];
  if (parentEntry && "children" in parentEntry) {
    parentEntry.children = parentEntry.children.filter((c) => c !== name);
  }

  entry.status = "destroyed";
  saveRegistry();
  log("info", "agent_destroyed", { name, type: entry.type });
}

/** Reset registry for testing — not for production use */
export function _resetForTesting(): void {
  registry = {};
}
