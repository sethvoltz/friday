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

  it("threads the captured shell env so the agent's Bash inherits the user PATH, overlaid on process.env", () => {
    // FRI-150/ADR-037: the agent's Claude Code process must receive the user's
    // captured interactive PATH (the missing half of the trust gradient).
    // Without `shellEnv` the SDK defaults `env` to the daemon's launchd-minimal
    // process.env and the agent can't find `gh`/brew tools on a fresh box.
    const shellEnv = { PATH: "/opt/homebrew/bin:/usr/bin", FOO_TOOLCHAIN: "1" };
    const out = buildQueryOptions(
      makeOpts("builder"),
      promptCmd,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      shellEnv,
    );
    // The captured PATH must WIN over whatever process.env carried (launchd
    // minimal), and Friday's own process.env vars must still be present.
    expect(out.env?.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(out.env?.FOO_TOOLCHAIN).toBe("1");
    expect(out.env?.HOME).toBe(process.env.HOME); // process.env preserved under the overlay
  });

  it("omits env entirely when no shell env is supplied (SDK falls back to process.env)", () => {
    const out = buildQueryOptions(
      makeOpts("helper"),
      promptCmd,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      undefined,
    );
    expect(out.env).toBeUndefined();
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
