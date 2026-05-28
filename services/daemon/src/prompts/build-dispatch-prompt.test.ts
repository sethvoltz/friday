/**
 * FRI-123: `buildDispatchPrompt` golden tests — one per
 * `DispatchIntent.kind`. Pins the systemPrompt + body composition
 * for each variant so future drift surfaces as a snapshot diff.
 *
 * Setup: real Postgres via `createTestDb`. Hooks are reset and not
 * re-registered, so the output is just the base-system-prompt
 * + caller-supplied body (no recall, no skill-context appendage).
 * The hook composition surface is covered independently by
 * `prompts/memory-recall-hook.test.ts` and
 * `hooks/skill-context.test.ts`, which exercise
 * `runHooks('before_prompt_build', ctx)` directly.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __resetHooksForTest, createTestDb, type TestDbHandle } from "@friday/shared";
import { saveEntry } from "@friday/memory";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "prompts_buildDispatch" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  __resetHooksForTest();
});

async function seedPin(agent: string, id: string, title: string, content: string): Promise<void> {
  const now = new Date().toISOString();
  await saveEntry({
    id,
    title,
    content,
    tags: ["pinned"],
    createdBy: agent,
    createdAt: now,
    updatedAt: now,
    recallCount: 0,
    lastRecalledAt: null,
  });
}

describe("buildDispatchPrompt (FRI-123)", () => {
  it("user_chat: body = userText; systemPrompt = base + pinned facts", async () => {
    await seedPin("orch", "pin-1", "test pin", "test value");
    const { buildDispatchPrompt } = await import("./build-dispatch-prompt.js");

    const out = await buildDispatchPrompt(
      { name: "orch", type: "orchestrator" },
      { kind: "user_chat", userText: "hello world" },
    );

    expect(out.body).toBe("hello world");
    expect(out.allowedToolsOverride).toBeUndefined();
    expect(out.systemPrompt).toContain("- **test pin**: test value");
    expect(out.systemPrompt).toContain("Your agent name is `orch`");
    await expect(out.systemPrompt).toMatchFileSnapshot(
      "./__golden__/build-dispatch-prompt.user_chat.txt",
    );
  });

  it("mail: body = caller-supplied mail prompt; intentText is the recall payload (not the body)", async () => {
    const { buildDispatchPrompt } = await import("./build-dispatch-prompt.js");

    const out = await buildDispatchPrompt(
      { name: "orch", type: "orchestrator" },
      {
        kind: "mail",
        body: "# Mail\n\n## from kitchen\n> hi there",
        intentText: "hi there",
      },
    );

    expect(out.body).toBe("# Mail\n\n## from kitchen\n> hi there");
    expect(out.allowedToolsOverride).toBeUndefined();
    await expect(out.systemPrompt).toMatchFileSnapshot(
      "./__golden__/build-dispatch-prompt.mail.txt",
    );
  });

  it("scheduled: body = caller-supplied state-stitched prompt", async () => {
    const { buildDispatchPrompt } = await import("./build-dispatch-prompt.js");

    const out = await buildDispatchPrompt(
      { name: "kitchen-cron", type: "scheduled" },
      {
        kind: "scheduled",
        body: "(state.md scaffolding)\n\nRun the cron task.",
        intentText: "Run the cron task.",
      },
    );

    expect(out.body).toBe("(state.md scaffolding)\n\nRun the cron task.");
    await expect(out.systemPrompt).toMatchFileSnapshot(
      "./__golden__/build-dispatch-prompt.scheduled.txt",
    );
  });

  it("scratch: body = userText; bare agent gets the bare prompt stack", async () => {
    const { buildDispatchPrompt } = await import("./build-dispatch-prompt.js");

    const out = await buildDispatchPrompt(
      { name: "scratch-eager-wolf", type: "bare" },
      { kind: "scratch", userText: "topic for this scratch agent" },
    );

    expect(out.body).toBe("topic for this scratch agent");
    expect(out.systemPrompt).toContain("Your agent name is `scratch-eager-wolf`");
    expect(out.systemPrompt).toContain("Your agent type is `bare`");
    await expect(out.systemPrompt).toMatchFileSnapshot(
      "./__golden__/build-dispatch-prompt.scratch.txt",
    );
  });

  it("agent_spawn: baseSystemPromptOverride bypasses buildSystemPrompt and is used verbatim", async () => {
    const { buildDispatchPrompt } = await import("./build-dispatch-prompt.js");

    const out = await buildDispatchPrompt(
      { name: "helper-1", type: "helper", parentName: "orch" },
      {
        kind: "agent_spawn",
        userText: "do the thing",
        baseSystemPromptOverride: "BOOTSTRAP_AUGMENTED_BASE",
      },
    );

    // With no hooks registered, baseSystemPromptOverride flows
    // through unchanged — proving the override path skips the
    // buildSystemPrompt slot (the override would otherwise be
    // shadowed by the constitution + soul + identity block).
    expect(out.systemPrompt).toBe("BOOTSTRAP_AUGMENTED_BASE");
    expect(out.body).toBe("do the thing");
  });

  it("agent_spawn (no override): falls back to buildSystemPrompt", async () => {
    const { buildDispatchPrompt } = await import("./build-dispatch-prompt.js");

    const out = await buildDispatchPrompt(
      { name: "helper-2", type: "helper", parentName: "orch" },
      { kind: "agent_spawn", userText: "do the thing" },
    );

    expect(out.systemPrompt).toContain("Your agent name is `helper-2`");
    expect(out.systemPrompt).toContain("Your parent agent is named `orch`");
    expect(out.body).toBe("do the thing");
  });
});
