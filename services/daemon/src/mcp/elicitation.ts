/**
 * FRI-152: `friday-elicitation` MCP server.
 *
 * Exposes a single tool `ask_user` that prompts the user with one or
 * more structured questions (mirroring the SDK built-in `AskUserQuestion`
 * schema) and returns the user's selection. Used INSTEAD of the built-in
 * because Friday runs the SDK in headless `query()` mode where the
 * built-in has no UI surface to prompt against (it auto-fails); the MCP
 * variant routes through the daemon → dashboard → user → daemon → MCP
 * handler chain, with the SDK's `await` on the MCP call providing the
 * load-bearing turn-pause property.
 *
 * Handler runs in the WORKER process (in-process MCP server, same as
 * friday-mail / friday-agents / friday-tickets etc.). It POSTs the
 * daemon's `/api/elicitation/wait` long-poll endpoint with the
 * SDK-supplied tool_use_id (read off `extra.toolUseId`); the daemon
 * registers an in-memory waiter and blocks the response until the
 * dashboard submits via `/api/elicitation/<id>/submit`. The handler
 * returns the answer payload as a `text` content block; the SDK wraps
 * it as the `tool_use`'s `tool_result` and the model continues.
 *
 * Return shape carries the richer `{kind, value}` discriminator (see
 * FRI-152 ticket §1) — the model can distinguish "user picked a listed
 * option" from "user typed in 'Other'". This is a deliberate improvement
 * over the SDK built-in's flat string return.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { daemonFetch, signalFrom } from "./http.js";

export const ELICITATION_SERVER_NAME = "friday-elicitation";

/** Single source of truth for the tool description visible to the model.
 *  Exported so the system prompt's protocol fragment can echo the same
 *  language verbatim (golden fixture). */
export const ASK_USER_DESCRIPTION = [
  "Ask the user a structured multiple-choice question (1-4 questions, 2-4 options each). Use this instead of the built-in `AskUserQuestion` tool — it is not available in this environment.",
  "",
  "Each question carries a short `header` (max ~12 chars, shown as a chip), the `question` text, 2-4 `options` with `label` + `description` + optional `preview`, and a `multiSelect` flag. The dashboard renders these as clickable cards; an 'Other' affordance is always added so the user can type a free-form answer.",
  "",
  "The response distinguishes 'user picked one of the listed options' (`kind: \"option\"`) from 'user typed something free-form' (`kind: \"other\"`). For multi-select questions the `value` is a comma+space joined string of the user's selections, in the order the user picked them. Per-question `notes` carry optional free-text context the user typed alongside their selection.",
  "",
  "The model's turn pauses inside this tool call until the user submits — there is no timeout. Plan your turn so that you only call `ask_user` when you genuinely need user input, not as a polling mechanism.",
].join("\n");

export interface BuildElicitationServerOptions {
  callerName: string;
  callerType: string;
  daemonPort: number;
}

const optionSchema = z.object({
  label: z.string().describe("Concise option label (1-5 words) shown on the option card."),
  description: z
    .string()
    .describe(
      "What this option means or its trade-offs. Shown beneath the label on the option card.",
    ),
  preview: z
    .string()
    .optional()
    .describe(
      "Optional preview content rendered behind a disclosure. Use for mockups, code snippets, or visual comparisons.",
    ),
});

const questionSchema = z.object({
  question: z
    .string()
    .describe("The full question text. Should end with a question mark and be clear and specific."),
  header: z
    .string()
    .describe(
      "Short chip label for this question (max ~12 chars), e.g. 'Auth method', 'Library', 'Approach'.",
    ),
  multiSelect: z
    .boolean()
    .default(false)
    .describe(
      "True when the user may pick more than one option. False for single-pick / radio-style questions.",
    ),
  options: z
    .array(optionSchema)
    .min(2)
    .max(4)
    .describe(
      "Available choices, 2-4 per question. Should be distinct and mutually exclusive (unless multiSelect is true). Do NOT include an 'Other' option — the dashboard always adds one.",
    ),
});

const askUserInputSchema = {
  questions: z
    .array(questionSchema)
    .min(1)
    .max(4)
    .describe("Questions to ask the user, 1-4 per call."),
};

export function buildElicitationServer(opts: BuildElicitationServerOptions) {
  const ctx = {
    port: opts.daemonPort,
    callerName: opts.callerName,
    callerType: opts.callerType,
  };
  return createSdkMcpServer({
    name: ELICITATION_SERVER_NAME,
    tools: [
      tool("ask_user", ASK_USER_DESCRIPTION, askUserInputSchema, async (args, extra) => {
        // SDK's `extra` carries the tool_use_id for this specific call;
        // we use it as the elicitation id so the dashboard can correlate
        // the SSE event + the submit POST + the canonical tool_use
        // block (which is keyed on the same id in the chat store).
        const toolUseId = (extra as { toolUseId?: string } | null | undefined)?.toolUseId ?? "";
        if (!toolUseId) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "ask_user invoked without a tool_use_id; cannot register elicitation waiter.",
              },
            ],
          };
        }
        const answer = await daemonFetch<{
          answers: Record<string, { kind: "option" | "other"; value: string }>;
          annotations?: Record<string, { notes?: string }>;
        }>({
          ...ctx,
          signal: signalFrom(extra),
          path: "/api/elicitation/wait",
          method: "POST",
          body: {
            agentName: opts.callerName,
            // The MCP SDK doesn't surface the SDK-side turn id to the
            // handler, but the daemon only needs it for SSE tagging
            // (the per-agent turn buffer routes events by `agent`).
            // Pass `extra.sessionId` when available; otherwise the
            // empty string is harmless on the daemon side.
            turnId: ((extra as { sessionId?: string } | null | undefined)?.sessionId ?? "") || "",
            toolUseId,
          },
        });
        // Echo the args back so the model has an unambiguous record of
        // exactly what it asked (the SDK's tool_result content_json
        // already carries `tool_use.input`, but having the questions
        // alongside the answers in the result makes the model's job
        // trivial — no cross-reference needed). FRI-152 §1.
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  questions: args.questions,
                  answers: answer.answers,
                  annotations: answer.annotations,
                },
                null,
                2,
              ),
            },
          ],
        };
      }),
    ],
  });
}
