/**
 * FRI-127 §2 / AC#3: `disallowedTools: ["Task"]` must be set on the SDK
 * `query()` options for EVERY agent type. The build is extracted into the pure
 * `buildQueryOptions` helper so the invariant can be asserted without forking a
 * worker. All five Friday agent types already carry a textual "do not use the
 * built-in Task tool" instruction; this hardens the rule at the SDK layer.
 */

import { describe, expect, it } from "vitest";
import type { AgentType } from "@friday/shared";
import { buildQueryOptions } from "./worker.js";
import type { WorkerPromptCommand, WorkerSpawnOptions } from "./worker-protocol.js";

function makeOpts(agentType: AgentType): WorkerSpawnOptions {
  return {
    agentName: `a-${agentType}`,
    agentType,
    workingDirectory: "/tmp/wt",
    systemPrompt: "sys",
    prompt: "do thing",
    turnId: "t_1",
    model: "claude-opus-4-7",
    daemonPort: 8765,
    mode: "long-lived",
  };
}

const promptCmd: WorkerPromptCommand = { prompt: "do thing", turnId: "t_1" };

describe("buildQueryOptions disallowedTools (FRI-127 §2)", () => {
  it.each<AgentType>(["orchestrator", "helper", "builder", "bare", "scheduled"])(
    "%s gets disallowedTools: ['Task']",
    (agentType) => {
      const out = buildQueryOptions(
        makeOpts(agentType),
        promptCmd,
        undefined, // sessionId
        undefined, // allowedTools
        undefined, // builderGuardHooks
        undefined, // thinking
        {}, // mcpServers
        undefined, // abortController
      );
      expect(out.disallowedTools).toEqual(["Task"]);
    },
  );

  it("threads the auto-approval allowedTools list independently of the Task block", () => {
    const out = buildQueryOptions(
      makeOpts("helper"),
      promptCmd,
      undefined,
      ["Read", "Grep"],
      undefined,
      undefined,
      {},
      undefined,
    );
    // allowedTools (auto-approval) and disallowedTools (catalog removal) are
    // distinct fields; setting one must not perturb the other.
    expect(out.allowedTools).toEqual(["Read", "Grep"]);
    expect(out.disallowedTools).toEqual(["Task"]);
  });

  it("sets resume only when a session id is present", () => {
    const withSession = buildQueryOptions(
      makeOpts("helper"),
      promptCmd,
      "sess-1",
      undefined,
      undefined,
      undefined,
      {},
      undefined,
    );
    expect(withSession.resume).toBe("sess-1");

    const withoutSession = buildQueryOptions(
      makeOpts("helper"),
      promptCmd,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      undefined,
    );
    expect(withoutSession.resume).toBeUndefined();
  });
});
