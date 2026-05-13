# MCP surface

Friday exposes its services to agents through MCP servers reconstructed inside each forked worker. Servers are gated by **caller type** at the worker boundary — the model only sees tools its agent type is authorized to use.

Server registration: `services/daemon/src/mcp/builder.ts`. Each server is built by a sibling file (`mail.ts`, `agents.ts`, `memory.ts`, `tickets.ts`, `schedule.ts`, `evolve.ts`, `integrations.ts`, `echo.ts`). The old `chat.ts` (`chat_reply` tool) was removed by FIX_FORWARD 8.5 — mail is the universal delivery primitive (ADR-017).

Tool names appear to the model as `mcp__<server-name>__<tool-name>` (e.g. `mcp__friday-mail__mail_send`).

## Built-in Claude tools (per agent type)

The Claude `claude_code` preset provides Read, Write, Edit, Bash, Glob, Grep. Friday disables the SDK's built-in `Memory` tool (`autoMemoryEnabled: false`) and the model is instructed not to use the SDK's `Task` sub-agent primitive. Friday's own MCP servers replace both.

## Friday MCP servers

| Server | Tools | Orchestrator | Builder | Helper | Scheduled | Bare |
|---|---|:-:|:-:|:-:|:-:|:-:|
| `friday-mail` | `mail_send` (with `priority: 'normal' \| 'critical'`), `mail_inbox`, `mail_read`, `mail_close` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `friday-agents` | `agent_create`, `agent_list`, `agent_status`, `agent_kill`, `agent_inspect`, `agent_delete_workspace` | ✓ | — | — | — | — |
| `friday-memory` | `memory_search`, `memory_get` (read-only); `memory_save`, `memory_update`, `memory_forget` (write) | ✓ R/W | ✓ R | ✓ R/W | ✓ R/W | ✓ R/W |
| `friday-tickets` | `ticket_create`, `ticket_list`, `ticket_get`, `ticket_update`, `ticket_comment`, `ticket_link_external` | ✓ | ✓ | ✓ | — | — |
| `friday-schedule` | `schedule_upsert`, `schedule_list`, `schedule_show`, `schedule_pause`, `schedule_resume`, `schedule_delete`, `schedule_trigger` | ✓ | — | — | — | — |
| `friday-evolve` | `evolve_list`, `evolve_get`, `evolve_save`, `evolve_update`, `evolve_apply`, `evolve_dismiss`, `evolve_scan`, `evolve_enrich`, `evolve_cluster` | ✓ | — | — | — | — |
| `friday-echo` | `echo` (sanity check) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `playwright` | `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_take_screenshot`, `browser_evaluate`, `browser_console_messages`, `browser_network_requests`, … (full `@playwright/mcp` surface) | — | ✓ | ✓ | ✓ | ✓ |

### Gating notes

- **No more `chat_reply` / `friday-chat`** (ADR-017). All user-visible deliveries go through `mail_send` with recipient `friday`; the orchestrator's mail-bridge surfaces them as `mail`-kind block rows in the chat. Builders and helpers address the user the same way.
- **`mail_send.priority`** (ADR-014 amendment). `'normal'` (default) queues for the next turn boundary; `'critical'` triggers mid-turn injection via `mail-wakeup-critical` IPC. Use sparingly — interrupting tool loops costs work in flight.
- **`agent_delete_workspace`** (FIX_FORWARD 6.4) is the strict-confirmation replacement for the old `workspace_cleanup`. The tool description language is contractual: the model MUST present the proposed deletion to the user and wait for an explicit "yes" message before invoking. The daemon also re-checks realpath containment under `~/.friday/workspaces/` before any rm-equivalent op.
- Builder gets `memory_search` / `memory_get` only — builders consult memory but mail the orchestrator with anything worth saving as canonical memory.
- Bare and scheduled don't touch tickets directly. Scheduled meta-agents push proposals through evolve, which the orchestrator turns into tickets.
- Schedule and evolve mutation are orchestrator-only — sub-agents shouldn't be modifying their own schedules or applying proposals.
- **`playwright`** is the only stdio (out-of-process) built-in. It launches Microsoft's `@playwright/mcp` via `npx -y @playwright/mcp@latest --headless --isolated` per worker — one fresh Chromium per agent, no shared profile (`SingletonLock` prevents that anyway). Orchestrator is excluded so long-running browser calls never block user responsiveness; browser work belongs in a spawned sub-agent. Shared logins across agents are deferred to a future `friday-secrets` MCP.

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
      "env": { "GCAL_TOKEN": "..." },
      "scope": ["orchestrator", "helper", "bare"]
    }
  ]
}
```

- Stdio transport only (the `command` / `args` / `env` shape). HTTP/SSE
  transports aren't wired yet.
- `scope` restricts by agent type. Empty or missing = all agent types.
- Names starting with `friday-` are reserved for in-process built-ins. The
  name `playwright` is also reserved (built-in browser MCP). Reserved names
  in user config are rejected with a warning in the daemon log.
- Malformed entries (e.g. missing `command`) are skipped, not fatal — a typo
  in config never blocks a worker from starting.
- The daemon reloads `~/.friday/config.json` on every spawn, so edits take
  effect on the next agent fork without a restart.

## Skill-driven tool restriction

When a skill declares `allowed_tools`, the daemon assembles the SDK call with the **intersection** of the agent's normal tool set and the skill's declared tools. Per-turn restriction only — never expansion. See `docs/chat-ux.md` §Skills.

## Pending tools (`docs/roadmap.md`)

- Linear `linear_import` — once `reconcile()` is wired.
