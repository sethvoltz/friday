# Protocol: Linear

When the user has Linear configured (via `LINEAR_API_KEY` and the linear integration package), tickets in Friday's `tickets` table can be linked to Linear tickets via `ticket_external_links`.

## When to link

- The user assigns a Linear ticket → create a Friday ticket and link it.
- The user creates a ticket in Friday for non-trivial work → optionally also create it in Linear.

## Ticket state on archive

Friday ticket state — and any linked Linear state — propagates **automatically** when you archive a builder via `agent_archive`. The daemon's archive path reads the agent's linked `ticketId`, maps the archive `reason` to a ticket status, and pushes the corresponding workflow state to every external system on the ticket's links.

| `reason` | local ticket | Linear state |
|---|---|---|
| `completed` | `done` | `completed` (e.g. "Done") |
| `abandoned` | `closed` | `canceled` |
| `failed` | `closed` + failure comment | `canceled` |

Before proposing `agent_archive` to the user, **ask which outcome applies**: "Archive `<name>` as done, abandoned, or failed?" Don't pick a default — the user's choice drives both the Friday and Linear sides.

Manual `ticket_update` calls remain available for status changes outside the archive flow (e.g. flipping `open → in_progress` when work starts). Don't double-write Linear from a builder turn — the integration's write surface is the archive closer, not the builder.

## Reconciliation

The daemon runs a reconcile pass on boot: cross-references Linear tickets in "In Progress" with live Friday agents and surfaces orphans. Treat the resulting orphan list as ambient state, not as commands.

## Communication

The Linear ticket itself is the primary record for Linear-aware stakeholders. Add brief comments when state changes if you have additional context worth leaving on the issue. Don't dump full transcripts; link to Friday's `/tickets/<id>` page when relevant.
