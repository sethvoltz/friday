/**
 * FRI-66: end-to-end assertion that every Friday in-process MCP tool
 * handler threads `extra.signal` through to `daemonFetch`. The unit tests
 * in `http-signal.test.ts` cover `signalFrom` and `daemonFetch` in
 * isolation; this file exercises the actual MCP builders so a future
 * regression that drops the `extra` parameter from a handler (or forgets
 * to call `signalFrom`) is caught at the builder boundary, not in the
 * field after a user hits Stop.
 *
 * Strategy: stub global `fetch`, build one tool server, locate a tool
 * definition, invoke its handler with `{ signal: <controller>.signal }`,
 * and assert that `fetch` was called with the same signal. We sample one
 * representative per builder rather than enumerating every tool — the
 * mechanical risk is "did the file's handlers get the (args, extra)
 * treatment," and a single tool per file is sufficient to detect that.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMailServer } from "./mail.js";
import { buildMemoryServer } from "./memory.js";
import { buildTicketsServer } from "./tickets.js";
import { buildAgentsServer } from "./agents.js";
import { buildScheduleServer } from "./schedule.js";
import { buildEvolveServer } from "./evolve.js";
import { buildIntegrationsServer } from "./integrations.js";
import { buildAppsServer } from "./apps.js";

interface ServerLike {
  instance: {
    // The MCP SDK's McpServer keeps registered tools on `_registeredTools`
    // (private but stable across the SDK versions Friday pins). The user's
    // tool function is exposed as `.handler` on each registered entry.
    _registeredTools: Record<
      string,
      {
        handler: (args: unknown, extra: unknown) => Promise<unknown>;
      }
    >;
  };
}

function getToolHandler(
  server: unknown,
  toolName: string,
): (args: unknown, extra: unknown) => Promise<unknown> {
  const s = server as ServerLike;
  const entry = s.instance._registeredTools[toolName];
  if (!entry) {
    throw new Error(
      `tool ${toolName} not found on server (have: ${Object.keys(s.instance._registeredTools).join(", ")})`,
    );
  }
  return entry.handler;
}

interface FetchCall {
  url: string;
  signal: AbortSignal | undefined;
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
const fetchCalls: FetchCall[] = [];

beforeEach(() => {
  fetchCalls.length = 0;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, signal: init?.signal ?? undefined });
      // Return a 200 with an empty JSON body so the daemonFetch wrapper
      // resolves cleanly. The handler bodies all stringify the result,
      // which works fine on {}.
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
});

afterEach(() => {
  fetchSpy.mockRestore();
});

async function expectSignalForwarded(
  callback: (args: unknown, extra: unknown) => Promise<unknown>,
  args: unknown,
): Promise<void> {
  const ctrl = new AbortController();
  await callback(args, { signal: ctrl.signal });
  expect(fetchCalls.length).toBeGreaterThan(0);
  // Use last call so handlers that issue multiple fetches still pass; in
  // practice every Friday handler is a single round-trip.
  const last = fetchCalls[fetchCalls.length - 1];
  expect(last.signal).toBe(ctrl.signal);
}

describe("MCP tool handlers thread extra.signal through to daemonFetch (FRI-66)", () => {
  // One representative per builder. The risk being tested is "the handler
  // signature picks up `extra`" — once that's true for one tool in a file,
  // the same edit covers the rest of that file's handlers (verified by the
  // grep-audit in the FRI-66 implementation).

  it("mail.mail_send forwards signal", async () => {
    const server = buildMailServer({
      callerName: "test-fri-66",
      callerType: "orchestrator",
      daemonPort: 1,
    });
    const cb = getToolHandler(server, "mail_send");
    await expectSignalForwarded(cb, {
      to: "friday",
      body: "test",
    });
  });

  it("memory.memory_search forwards signal", async () => {
    const server = buildMemoryServer({
      callerName: "test-fri-66",
      callerType: "orchestrator",
      daemonPort: 1,
    });
    const cb = getToolHandler(server, "memory_search");
    await expectSignalForwarded(cb, { query: "hello" });
  });

  it("tickets.ticket_create forwards signal", async () => {
    const server = buildTicketsServer({
      callerName: "test-fri-66",
      callerType: "orchestrator",
      daemonPort: 1,
    });
    const cb = getToolHandler(server, "ticket_create");
    await expectSignalForwarded(cb, { title: "hi" });
  });

  it("agents.agent_list forwards signal", async () => {
    const server = buildAgentsServer({
      callerName: "test-fri-66",
      callerType: "orchestrator",
      daemonPort: 1,
    });
    const cb = getToolHandler(server, "agent_list");
    await expectSignalForwarded(cb, {});
  });

  it("schedule.schedule_list forwards signal", async () => {
    const server = buildScheduleServer({
      callerName: "test-fri-66",
      callerType: "orchestrator",
      daemonPort: 1,
    });
    const cb = getToolHandler(server, "schedule_list");
    await expectSignalForwarded(cb, {});
  });

  it("evolve.evolve_list forwards signal", async () => {
    const server = buildEvolveServer({
      callerName: "test-fri-66",
      callerType: "orchestrator",
      daemonPort: 1,
    });
    const cb = getToolHandler(server, "evolve_list");
    await expectSignalForwarded(cb, {});
  });

  it("integrations.linear_create_issue forwards signal", async () => {
    const server = buildIntegrationsServer({
      callerName: "test-fri-66",
      callerType: "orchestrator",
      daemonPort: 1,
    });
    const cb = getToolHandler(server, "linear_create_issue");
    await expectSignalForwarded(cb, { title: "hi" });
  });

  it("apps.app_list forwards signal", async () => {
    const server = buildAppsServer({
      callerName: "test-fri-66",
      callerType: "orchestrator",
      daemonPort: 1,
    });
    const cb = getToolHandler(server, "app_list");
    await expectSignalForwarded(cb, {});
  });
});
