# MCP surface

Friday exposes its services to agents through MCP servers reconstructed inside each forked worker. Servers are gated by **caller type** at the worker boundary — the model only sees tools its agent type is authorized to use.

Server registration: `services/daemon/src/mcp/builder.ts`. Each server is built by a sibling file (`mail.ts`, `chat.ts`, `agents.ts`, `memory.ts`, `tickets.ts`, `schedule.ts`, `evolve.ts`, `echo.ts`).

Tool names appear to the model as `mcp__<server-name>__<tool-name>` (e.g. `mcp__friday-mail__mail_send`).

## Built-in Claude tools (per agent type)

The Claude `claude_code` preset provides Read, Write, Edit, Bash, Glob, Grep. Friday disables the SDK's built-in `Memory` tool (`autoMemoryEnabled: false`) and the model is instructed not to use the SDK's `Task` sub-agent primitive. Friday's own MCP servers replace both.

## Friday MCP servers

| Server | Tools | Orchestrator | Builder | Helper | Scheduled | Bare |
|---|---|:-:|:-:|:-:|:-:|:-:|
| `friday-chat` | `chat_reply` | ✓ | — | ✓ | ✓ | ✓ |
| `friday-mail` | `mail_send`, `mail_inbox`, `mail_read`, `mail_close` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `friday-agents` | `agent_create`, `agent_list`, `agent_status`, `agent_kill`, `agent_inspect`, `workspace_cleanup` | ✓ | — | — | — | — |
| `friday-memory` | `memory_search`, `memory_get` (read-only); `memory_save`, `memory_update`, `memory_forget` (write) | ✓ R/W | ✓ R | ✓ R/W | ✓ R/W | ✓ R/W |
| `friday-tickets` | `ticket_create`, `ticket_list`, `ticket_get`, `ticket_update`, `ticket_comment`, `ticket_link_external` | ✓ | ✓ | ✓ | — | — |
| `friday-schedule` | `schedule_upsert`, `schedule_list`, `schedule_show`, `schedule_pause`, `schedule_resume`, `schedule_delete`, `schedule_trigger` | ✓ | — | — | — | — |
| `friday-evolve` | `evolve_list`, `evolve_get`, `evolve_save`, `evolve_update`, `evolve_apply`, `evolve_dismiss` | ✓ | — | — | — | — |
| `friday-echo` | `echo` (sanity check) | ✓ | ✓ | ✓ | ✓ | ✓ |

### Gating notes

- Builder gets `memory_search` / `memory_get` only — builders consult memory but mail the orchestrator with anything worth saving as canonical memory.
- Builder doesn't get `chat_reply`. Builders communicate via mail + PR; chatting to the user is the orchestrator's job.
- Bare and scheduled don't touch tickets directly. Scheduled meta-agents push proposals through evolve, which the orchestrator turns into tickets.
- Schedule and evolve mutation are orchestrator-only — sub-agents shouldn't be modifying their own schedules or applying proposals.

## Tool handlers — HTTP loopback

All Friday MCP tool handlers HTTP-call the daemon at `127.0.0.1:<daemonPort>`. They never call shared services directly. Two reasons:

1. **Architecture intent.** The daemon is the sole writer of SQLite. Routing through HTTP keeps that contract.
2. **Auditability.** Every agent action goes through the same code path the dashboard uses. Logging, request tracing, future rate-limiting all hook in one place.

Cost: ~1ms per call on localhost — negligible at LLM-tier latency.

The handlers send `x-friday-caller-name` and `x-friday-caller-type` headers so the API can use them for `createdBy` / `author` / audit fields.

## User-configured MCP servers

In `~/.friday/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "gcal",
      "command": "npx",
      "args": ["-y", "@some-org/mcp-gcal"],
      "env": { "GCAL_TOKEN": "$GCAL_TOKEN" },
      "scope": ["orchestrator", "helper", "bare"]
    }
  ]
}
```

- `scope` restricts by agent type. Default: all agent types.
- Env interpolation reads from `~/.friday/.env`.
- Settings UI exposes a list view + "Add MCP server" form. Direct file edits also supported.

## Skill-driven tool restriction

When a skill declares `allowed_tools`, the daemon assembles the SDK call with the **intersection** of the agent's normal tool set and the skill's declared tools. Per-turn restriction only — never expansion. See `docs/chat-ux.md` §Skills.

## Pending tools (`docs/roadmap.md`)

- Linear `linear_import` — once `reconcile()` is wired.
- Friday-evolve scan-trigger tools (`evolve_scan`, `evolve_enrich`, `evolve_cluster`) — when the pipeline lifts from the old codebase.
