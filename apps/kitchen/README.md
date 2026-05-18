# Kitchen Friday App

A meal-planning Friday App. Owns:

- Recipe library (`recipes.json`).
- Recurring routines (`routines.json`).
- Weekly menus (`menus/<YYYY-Wxx>.json`, one file per ISO week).
- History of what was actually eaten (`history.json`).

Family / location / dietary context stays in Friday's memory store
(`tags: ["family"]`) — the agents recall it via `memory_search`.

## Agents

- **`kitchen`** (bare) — conversational meal-planning partner.
- **`scheduled-kitchen-weekly`** (scheduled, `17 3 * * 0`) — Sunday 03:17
  local. Drafts the upcoming week and mails `friday` + `kitchen`.

## Install

```sh
# Copy this folder to your apps data dir
cp -R apps/kitchen ~/.friday/apps/kitchen

# Install runtime deps (MCP SDK). --ignore-scripts is recommended.
( cd ~/.friday/apps/kitchen && npm install --omit=dev --ignore-scripts )

# Install via Friday's MCP tool surface (from the orchestrator):
#   app_install({ path: "~/.friday/apps/kitchen" })
```

Verify with `app_inspect({ app: "kitchen" })`. The two agents and the
weekly schedule should be registered.

## MCP tools

App-scoped (only `kitchen` and `scheduled-kitchen-weekly` see them):

| Tool | Purpose |
|---|---|
| `kitchen_recipe_list` | List recipes; filter by `tags[]` and/or `status`. |
| `kitchen_recipe_add` | Add a recipe. |
| `kitchen_recipe_update` | Patch a recipe by `id`. |
| `kitchen_recipe_archive` | Set `status="deferred"` (preserve-over-delete). |
| `kitchen_routine_list` | List routines. |
| `kitchen_routine_add` | Add a routine. |
| `kitchen_routine_update` | Patch a routine by `id`. |
| `kitchen_menu_save` | Save the menu for one ISO week. |
| `kitchen_menu_get` | Read one week's menu. |
| `kitchen_menu_list_recent` | Recent weeks, newest first. |
| `kitchen_history_add` | Record what was eaten on a date. |
| `kitchen_history_list` | List history newest first; `sinceDate` and `limit` optional. |
