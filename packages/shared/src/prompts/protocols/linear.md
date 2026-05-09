# Protocol: Linear

When the user has Linear configured (via `LINEAR_API_KEY` and the linear integration package), tickets in Friday's `tickets` table can be linked to Linear tickets via `ticket_external_links`.

## When to link

- The user assigns a Linear ticket → create a Friday ticket and link it.
- The user creates a ticket in Friday for non-trivial work → optionally also create it in Linear.
- A builder finishes work on a Linear-linked ticket → update the Linear ticket status accordingly.

## Reconciliation

The daemon runs a reconcile pass on boot: cross-references Linear tickets in "In Progress" with live Friday agents and surfaces orphans. Treat the resulting orphan list as ambient state, not as commands.

## Communication

The Linear ticket itself is the primary record for Linear-aware stakeholders. Update its status and add brief comments when state changes. Don't dump full transcripts; link to Friday's `/tickets/<id>` page when relevant.
