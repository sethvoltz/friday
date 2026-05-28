/**
 * FRI-123: `DispatchIntent` — the single input shape for
 * `buildDispatchPrompt`. Replaces the wide positional-arg seam
 * `{ intentText, intentTag, body, agentType, baseSystemPrompt, skillMatch }`
 * that was duplicated across 8 call sites in the daemon.
 *
 * One discriminator (`kind`) drives:
 *   - The `intentTag` threaded into `runHooks('before_prompt_build')`
 *     so memory recall + skill-context fire with the right scope tag.
 *   - The recall payload (what text the memory listener queries
 *     against) — `userText` for direct user input, `intentText` for
 *     mail/scheduled where the body is wrapper scaffolding around
 *     the real intent.
 *   - The dispatch body (what the worker receives as its prompt
 *     argument) — `userText` for direct user input, `body` for
 *     mail/scheduled where the prompt is pre-formatted by the
 *     caller (mail-bridge stitches mail headers; scheduler stitches
 *     state.md context).
 *
 * Callers pre-format their wrapper strings — the prompt module
 * does NOT import mail/scheduler schemas. Mail formatting lives in
 * `comms/mail-prompt.ts`; schedule state-stitching lives in
 * `scheduler/state.ts`.
 *
 * The `agent_spawn` variant carries `baseSystemPromptOverride`
 * because the `agent:bootstrap` hook fires at spawn time only
 * (lifecycle concern, not prompt concern) and produces an
 * augmented base prompt that the spawn handler must thread through.
 * When set, `buildDispatchPrompt` uses it verbatim instead of
 * calling `buildSystemPrompt` itself.
 */
export type DispatchIntent =
  | {
      kind: "user_chat";
      userText: string;
      skillMatch?: import("@friday/shared").SkillMatch;
    }
  | { kind: "mail"; body: string; intentText: string }
  | { kind: "scheduled"; body: string; intentText: string }
  | { kind: "scratch"; userText: string }
  | { kind: "agent_spawn"; userText: string; baseSystemPromptOverride?: string };
