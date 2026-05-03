import { describe, it, expect } from "vitest";
import { buildAgentSystemPrompt, buildFirstTurnPrompt } from "./prime.js";
import { BEADS_DIR } from "@friday/shared";

describe("buildAgentSystemPrompt", () => {
  it("builds orchestrator prompt with identity and decision framework", () => {
    const prompt = buildAgentSystemPrompt({
      agentName: "orchestrator",
      agentType: "orchestrator",
      cwd: "/tmp",
    });
    // Identity
    expect(prompt).toContain("You are the Orchestrator");
    expect(prompt).toContain("manager");

    // Decision framework — delegate vs handle
    expect(prompt).toContain("Trivial");
    expect(prompt).toContain("delegate");
    expect(prompt).toContain("agent_create");

    // Availability — stay responsive
    expect(prompt).toContain("Stay available");
    expect(prompt).toContain("Never block");

    // Naming — descriptive, unique, permanent
    expect(prompt).toContain("Naming agents");
    expect(prompt).toContain("never be reused");

    // Mail processing — must read mail itself
    expect(prompt).toContain("mail_read");
    expect(prompt).toContain("mail_check");
    expect(prompt).toContain("mail_send");
    expect(prompt).toContain("mail_close");

    // Beads
    expect(prompt).toContain(BEADS_DIR);
    expect(prompt).toContain("bd create --epic");

    // Slack
    expect(prompt).toContain("slack_reply");
    expect(prompt).toContain("mrkdwn");

    // Helper lifecycle — one per task, destroy when done
    expect(prompt).toContain("Helper lifecycle");
    expect(prompt).toContain("One helper, one task");
    expect(prompt).toContain("Follow-ups are fine, new tasks are not");
    expect(prompt).toContain("Destroy when done");

    // Builder Isolation Rules block — hardcoded, before "How to delegate"
    expect(prompt).toContain("Builder Isolation Rules");
    expect(prompt).toContain("restricted to their workspace path");
    expect(prompt).toContain("Out-of-workspace data requests must be relayed");
    expect(prompt).toContain("bd and orchestration meta-commands are exempt");
    const isolationIdx = prompt.indexOf("Builder Isolation Rules");
    const delegateIdx = prompt.indexOf("How to delegate");
    expect(isolationIdx).toBeLessThan(delegateIdx);

    // Memory — auto-recall, reflexive saving, update tool
    expect(prompt).toContain("automatically injected");
    expect(prompt).toContain("memory-context");
    expect(prompt).toContain("EVERY conversation turn");
    expect(prompt).toContain("memory_update");

    // Work complete — builder already pushed, no approval gate
    expect(prompt).toContain("already pushed and opened a PR");
    expect(prompt).not.toContain("has NOT pushed yet");
    expect(prompt).not.toContain("approve pushing");

    // Turn discipline
    expect(prompt).toContain("End your turn");

    // Status checking — actually investigate
    expect(prompt).toContain("git -C");
    expect(prompt).toContain("bd list --parent");
  });

  it("builds builder prompt with workspace and epic context", () => {
    const prompt = buildAgentSystemPrompt({
      agentName: "builder-auth",
      agentType: "builder",
      cwd: "/tmp/workspaces/builder-auth",
      parent: "orchestrator",
      workspace: "/tmp/workspaces/builder-auth",
      epicId: "bd-a1b2",
    });
    expect(prompt).toContain('Builder "builder-auth"');
    expect(prompt).toContain("bd-a1b2");
    expect(prompt).toContain("orchestrator");
    expect(prompt).toContain("/tmp/workspaces/builder-auth");

    // Workflow phases
    expect(prompt).toContain("Phase 1");
    expect(prompt).toContain("Phase 2");
    expect(prompt).toContain("Phase 3");

    // Mail for communication
    expect(prompt).toContain("mail_send");
    expect(prompt).toContain("mail_check");

    // No direct user contact
    expect(prompt).toContain("cannot talk to the user");

    // Helper cleanup — destroy when done, don't reuse for different tasks
    expect(prompt).toContain("agent_destroy");
    expect(prompt).toContain("stale context");

    // Auto-push on completion — no approval gate
    expect(prompt).toContain("git push -u origin HEAD");
    expect(prompt).toContain("gh pr create");
    expect(prompt).not.toContain("Do NOT push. Do NOT open a PR");
    expect(prompt).not.toContain("explicit push approval");
    expect(prompt).not.toContain("Do not push or open a PR until told to");

    // Beads dir
    expect(prompt).toContain(BEADS_DIR);
  });

  it("builds helper prompt with task and parent context", () => {
    const prompt = buildAgentSystemPrompt({
      agentName: "helper-auth-tests",
      agentType: "helper",
      cwd: "/tmp/workspaces/builder-auth",
      parent: "builder-auth",
      taskId: "bd-c3d4",
    });
    expect(prompt).toContain('Helper "helper-auth-tests"');
    expect(prompt).toContain("bd-c3d4");
    expect(prompt).toContain("builder-auth");

    // Mail
    expect(prompt).toContain("mail_send");
    expect(prompt).toContain("mail_check");

    // No user contact, no creating agents
    expect(prompt).toContain("cannot create other agents");
    expect(prompt).toContain("cannot talk to the user");

    // Beads dir
    expect(prompt).toContain(BEADS_DIR);
  });
});

describe("buildFirstTurnPrompt", () => {
  it("orchestrator checks mail and beads on startup", () => {
    const prompt = buildFirstTurnPrompt({
      agentName: "orchestrator",
      agentType: "orchestrator",
      cwd: "/tmp",
    });
    expect(prompt).toContain("mail_check");
    expect(prompt).toContain("bd ready");
  });

  it("builder with epic reads it and plans", () => {
    const prompt = buildFirstTurnPrompt({
      agentName: "builder-auth",
      agentType: "builder",
      cwd: "/tmp",
      epicId: "bd-a1b2",
    });
    expect(prompt).toContain("bd-a1b2");
    expect(prompt).toContain("bd show");
    expect(prompt).toContain("plan");
  });

  it("builder without epic checks mail", () => {
    const prompt = buildFirstTurnPrompt({
      agentName: "builder-auth",
      agentType: "builder",
      cwd: "/tmp",
      epicId: null,
    });
    expect(prompt).toContain("mail_check");
  });

  it("helper with task reads it", () => {
    const prompt = buildFirstTurnPrompt({
      agentName: "helper-tests",
      agentType: "helper",
      cwd: "/tmp",
      taskId: "bd-c3d4",
    });
    expect(prompt).toContain("bd-c3d4");
    expect(prompt).toContain("bd show");
    expect(prompt).toContain("mail your parent");
  });

  it("helper without task checks mail", () => {
    const prompt = buildFirstTurnPrompt({
      agentName: "helper-x",
      agentType: "helper",
      cwd: "/tmp",
      taskId: null,
    });
    expect(prompt).toContain("mail_check");
  });
});
