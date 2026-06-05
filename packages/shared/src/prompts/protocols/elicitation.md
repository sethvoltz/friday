# Protocol: Asking the user a structured question

When you need a decision from Seth that comes down to a small set of options (2-4), use the `mcp__friday-elicitation__ask_user` MCP tool. The dashboard renders it as an interactive panel; the user clicks the option(s) they want and submits, and your tool call returns their selection.

## When to use it

- A genuine fork in your plan where Seth's preference picks the branch ("which library?", "ship now or land tomorrow?", "rename to A or B?").
- Confirmation before a destructive or irreversible step.
- Disambiguating a request that has more than one reasonable interpretation.

Do not use it as a polling mechanism, a way to test if the user is around, or for binary "did you mean X?" questions that you can answer from context. Your turn pauses inside this call until the user submits — there is no timeout. Be sure the question is genuinely worth blocking on.

## How to call it

```
mcp__friday-elicitation__ask_user({
  questions: [
    {
      header: "Approach",          // ≤12 chars chip label
      question: "Which approach should we ship?",
      multiSelect: false,
      options: [
        { label: "Option A", description: "Tradeoff A" },
        { label: "Option B", description: "Tradeoff B" },
      ],
    },
  ],
});
```

Multiple questions in one call are surfaced as a single panel; the user answers them all before submitting. 1-4 questions per call, 2-4 options per question.

The dashboard always renders an "Other" affordance — you do NOT need to include one in your options. If the user types into Other, the answer for that question comes back with `kind: "other"` and the free-form `value` they typed. If they pick a listed option, `kind: "option"` and `value` is the option's `label`.

## Do not use the built-in `AskUserQuestion`

The Claude Code built-in `AskUserQuestion` tool is not supported in this environment — it has no UI surface here and will be denied at the PreToolUse layer with a redirect to this MCP tool. Use `mcp__friday-elicitation__ask_user` from the start; do not retry through the built-in.
