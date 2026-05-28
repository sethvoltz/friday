/**
 * FRI-123: `buildSystemPrompt` golden test.
 *
 * Pins the watchdog refork path's prompt assembly. The watchdog
 * dispatches with `buildSystemPrompt` directly (no intent — no
 * `before_prompt_build` hooks fire), so the output is just:
 *   CONSTITUTION + SOUL + identity + pinned facts + agents/<type> +
 *   protocols/*
 *
 * The test seeds a deterministic pinned fact via the real
 * `@friday/memory` store against `createTestDb` (project rule —
 * stateful code needs stateful tests; no mocks). With no hooks
 * registered the composition is reproducible across reruns —
 * `listPinnedForAgent` sorts by id (verified in store.test.ts), and
 * the prompt-stack files are stable at HEAD.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __resetHooksForTest, createTestDb, type TestDbHandle } from "@friday/shared";
import { saveEntry } from "@friday/memory";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "prompts_buildSystem" });
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

describe("buildSystemPrompt (FRI-123)", () => {
  it("composes a deterministic base system prompt for the watchdog refork path", async () => {
    await seedPin("orch", "pin-alpha", "fact alpha", "value alpha");
    await seedPin("orch", "pin-beta", "fact beta", "value beta");
    const { buildSystemPrompt } = await import("./build-system-prompt.js");

    const { systemPrompt } = await buildSystemPrompt({
      name: "orch",
      type: "orchestrator",
    });

    // Structural pins — these are the load-bearing assertions; the
    // golden snapshot below catches any other drift.
    expect(systemPrompt).toContain("# Identity");
    expect(systemPrompt).toContain("Your agent name is `orch`");
    expect(systemPrompt).toContain("Your agent type is `orchestrator`");
    expect(systemPrompt).toContain("# Pinned facts");
    expect(systemPrompt).toContain("- **fact alpha**: value alpha");
    expect(systemPrompt).toContain("- **fact beta**: value beta");

    // Stable golden — pinned facts sort by id (alpha < beta) per
    // listPinnedForAgent's order; the prompt-stack files are pinned
    // content at HEAD; no hooks registered → no recall / skill-context
    // appendage.
    await expect(systemPrompt).toMatchFileSnapshot("./__golden__/build-system-prompt.txt");
  });

  it("returns a prompt without # Pinned facts when the agent has no pinned entries", async () => {
    const { buildSystemPrompt } = await import("./build-system-prompt.js");

    const { systemPrompt } = await buildSystemPrompt({
      name: "lonely",
      type: "orchestrator",
    });

    expect(systemPrompt).not.toContain("# Pinned facts");
    expect(systemPrompt).toContain("Your agent name is `lonely`");
  });

  it("threads parentName into the identity block for child agents", async () => {
    const { buildSystemPrompt } = await import("./build-system-prompt.js");

    const { systemPrompt } = await buildSystemPrompt({
      name: "helper-1",
      type: "helper",
      parentName: "orch",
    });

    expect(systemPrompt).toContain("Your agent name is `helper-1`");
    expect(systemPrompt).toContain("Your parent agent is named `orch`");
  });
});
