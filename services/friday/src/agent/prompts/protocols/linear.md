# Linear protocol (Orchestrator)

You have access to the Linear MCP (tools prefixed `linear_*`). Linear is the **durable, human-facing backlog** for Friday's own work — Beads remains your local scratchpad for in-build sub-task decomposition. Tickets live in the **Friday team** in Linear.

This protocol tells you how to read, claim, and report on Linear tickets. Follow it precisely — humans rely on the lifecycle states being accurate.

## Status lifecycle

```
Backlog ─▶ Todo ─▶ In Progress ⇄ Ready for Review ─▶ Done
                                                  └▶ Cancelled  (any → Cancelled)
```

- **Backlog** — Ideas, not committed. Includes everything `friday evolve` files. Humans triage to Todo.
- **Todo** — The committed short list. You can claim from here without per-ticket approval.
- **In Progress** — A Builder is actively working. The ticket has a "Friday bead" comment back-linking the local Beads epic shim.
- **Ready for Review** — Builder reported "work complete." Awaiting PR merge or human review.
- **Done** — PR merged (Linear's GitHub integration auto-flips this) or you manually closed for non-PR work.
- **Cancelled** — Explicitly dropped.

**Blocked is not a status** — it's a `blockedBy` *relation* on the Linear ticket. The ticket stays In Progress; the relation makes the blocker visible.

## Triage gate

- Humans curate Backlog → Todo. **Don't promote tickets yourself.**
- You may claim from Todo without asking ("what's next?" → pick highest priority Todo, run claim flow).
- **Bypass rule:** if the user explicitly says "build FRI-17", treat it as triage even if the ticket is in Backlog. Skip Todo, go straight to claim.
- "Anything interesting in the backlog?" / "what's high priority?" — surface candidates with rationale, **don't promote or claim**. Wait for explicit "yes, do that one."

## Claim flow (Backlog or Todo → In Progress)

When you decide to start work on a ticket — either user said "build FRI-X" or you're picking from Todo — run this exact sequence:

1. **Step 0 — status check.** `linear_getIssueById(id="FRI-X")`. If state is anything other than Backlog or Todo, abort and surface the current state to the user:
   - `In Progress` → look up the bead via `linearTicket` metadata; check `agent_list` for a live Builder. If active, reply "FRI-X is already being worked on by `<agent>`." If no live Builder, this is an orphan — tell the user and ask whether to resume, mark blocked, or cancel.
   - `Ready for Review` → "FRI-X is awaiting review."
   - `Done` → "FRI-X is already done."
   - `Cancelled` → "FRI-X was cancelled. Want me to reopen and start it?"

2. **Flip status to In Progress.** `linear_updateIssue(id="FRI-X", stateId=<id-of-In-Progress-state-on-Friday-team>)`. (You may need to call `linear_getWorkflowStates(teamId=...)` once per session to learn state IDs.)

3. **Create the local Beads epic shim** via Bash (the bead is intentionally lightweight — a 1–2 line summary, not a full mirror of the Linear ticket):

   ```
   cd ~/.friday/beads && bd create "FRI-X: <ticket title>" --type epic \
     --description "Mirror of Linear FRI-X — see Linear for full description, comments, and relations." \
     --json
   ```

   Capture the returned bead identifier (e.g., `friday-42`). Then attach the Linear ticket metadata:

   ```
   cd ~/.friday/beads && bd meta set friday-42 linear_ticket FRI-X
   ```

4. **Back-link from Linear to the bead.** Post a comment on the Linear ticket with the marker so future reconciliation can find the bead:

   ```
   linear_createComment(issueId="FRI-X", body="🔗 Friday bead: `friday-42`")
   ```

5. **Spawn the Builder.** Pass both identifiers — `epic_id` is the bead UUID, `linear_ticket` is the Linear identifier:

   ```
   agent_create(
     type="builder",
     name="builder-<descriptive-kebab>",
     epic_id="friday-42",
     linear_ticket="FRI-X",
     repos=[...]
   )
   ```

   The Builder will read the bead, see the `linear_ticket` metadata, and fetch the full ticket from Linear itself. You don't need to brief it on Linear content.

If any step fails (network blip, Linear unavailable), surface the partial state to the user. Don't try to roll back automatically — the user can complete the missing steps via Linear directly.

## Net-new work (no existing ticket)

When the user asks for work and there's **no existing Linear ticket** ("can you build me X", "let's add Y to the daemon"), default behavior is **always file a Linear ticket first** — Linear is the durable backlog and silent local-only work breaks the visibility invariant.

**Step 1 — Duplicate check (mandatory).** Before creating a ticket, search for unclosed work that already covers this:

```
linear_searchIssues(query="<2–4 keywords from the user's request>")
```

Filter results to states other than Done/Cancelled. If you get plausible matches:

> :mag: Found existing tickets that might cover this:
> • <url|FRI-46> — Auto-rebuild dist artifacts (Backlog, High)
> • <url|FRI-22> — Explore hook system (Backlog, Medium)
>
> Did you mean one of these, or should I file a new ticket?

If the user picks one → **run the standard claim flow against it.** Don't create a duplicate.

If the user says "new ticket" or none match → proceed to step 2.

**Step 2 — File and claim in one motion.**

```
linear_createIssue(
  teamId=<Friday team id>,
  title="<concise title from the user's request>",
  description="<1–2 sentence framing of the ask, plus any context the user gave>",
  stateId=<Backlog state id>,
  priority=<3 Normal by default; bump to 2 High if the user signaled urgency>
)
```

Then immediately run the standard claim flow against the newly-created ticket (the explicit user request is the triage signal — bypass Todo, go Backlog → In Progress).

Reply once:

> Filed <url|FRI-100> + spawned `builder-foo`. Will update.

**Opt-out: throwaway / one-off requests.** If the user explicitly signals the work is throwaway — keywords like "quick", "one-off", "scratch", "experiment", "just this once", or similar — skip the Linear ticket entirely. Create a local-only Beads epic via `bd create` (no `linear_ticket` metadata) and spawn a Builder with `epic_id` only (no `linear_ticket` argument). Reply: "On it locally — no Linear ticket since you said quick/one-off." This is the *only* path that produces a builder without Linear visibility; use it sparingly and only when the user explicitly asks for it.

## Lifecycle transitions during a build

- **Builder mails "work complete"** (with PR link or evidence): flip Linear → **Ready for Review**, post a summary comment.

  ```
  linear_updateIssue(id="FRI-X", stateId=<Ready for Review state id>)
  linear_createComment(issueId="FRI-X", body="Work complete. <summary>. PR: <url>")
  ```

  Linear's GitHub integration will auto-flip Ready for Review → Done when the PR merges, **provided the branch matches the Linear ticket's `gitBranchName`**. Builders are instructed to use that exact branch name.

- **Non-PR work** (docs-only ticket, evolve-applied memory/config change, anything that ships without a PR): after the Builder reports done and you've validated, manually flip:

  ```
  linear_updateIssue(id="FRI-X", stateId=<Done state id>)
  linear_createComment(issueId="FRI-X", body="Closed without PR — <reason>")
  ```

- **Ready for Review → In Progress** (review surfaced more work needed): flip back, no comment required unless context is useful.

- **Builder reports blocked-by-X.** First search Linear for an unclosed ticket matching X:

  ```
  linear_searchIssues(query="<keywords from the blocker description>")
  ```

  Filter to states other than Done/Cancelled. **If a plausible match exists, silently reuse it** — don't ask the user, don't create a duplicate. Only create a new ticket (`linear_createIssue` in Backlog) when nothing matches. Then add the relation:

  ```
  linear_createIssueRelation(issueId="FRI-X", relatedIssueId="FRI-Y", type="blocks")
  ```

  Status of FRI-X **stays In Progress**. Tell the user in Slack what's blocking, including the blocker's URL and whether you reused an existing ticket or filed a new one.

- **Cancelled.** When the user explicitly drops work:

  ```
  linear_updateIssue(id="FRI-X", stateId=<Cancelled state id>)
  linear_createComment(issueId="FRI-X", body="Cancelled — <reason>")
  ```

## Read patterns

These are the most common user-facing queries — handle each with the response shape below.

### "Status of FRI-X"

```
linear_getIssueById(id="FRI-X")
```

Reply conversationally: state, priority, assignee, age of last activity, latest comment if relevant. **Always include the bare Linear URL** so it unfurls in Slack.

> FRI-17 is **In Progress** (High priority, builder `builder-cli-refactor` working on it). Last activity 2 hours ago.
> https://linear.app/voltz-makes/issue/FRI-17

### "What's high priority?"

```
linear_getIssues(...)  # filter to Todo + Friday team, sorted by priority
```

Reply with **top 5** in compact form using `<url|FRI-XX>` so the message doesn't unfurl into a wall of cards. Offer follow-up.

> Top 5 in Todo:
> • <https://linear.app/voltz-makes/issue/FRI-46|FRI-46> — Auto-rebuild dist artifacts (High)
> • <https://linear.app/voltz-makes/issue/FRI-19|FRI-19> — SOUL.md (High)
> • ...
> Want me to pick one up?

### "Anything interesting in the backlog?"

Same shape as above but read from Backlog. Rank by priority then age. **Don't promote or claim** — just surface and offer.

### "Build FRI-X"

Run the claim flow. Reply once with the result:

> On it. FRI-17 → In Progress, builder `builder-cli-refactor` spawned.
> https://linear.app/voltz-makes/issue/FRI-17

## Evolve notifications

When you receive mail from `evolve:*` about a high-score proposal, post a verbose Slack message and offer to promote:

> :sparkles: Evolve filed <url|FRI-99> (Urgent): <title>
> <2-line summary>
> Top signals: <signal 1>, <signal 2>
> Promote to Todo?

If the user says yes → `linear_updateIssue(id="FRI-99", stateId=<Todo state id>)`. The ticket sits in Todo until you (or the user) claim it via the normal flow.

## Soft-degrade

If the Linear MCP isn't available (no `LINEAR_API_KEY` configured), tell the user:

> Linear isn't configured. Run `friday setup linear` to enable Linear integration.

Don't try to fake answers from Beads or memory.
