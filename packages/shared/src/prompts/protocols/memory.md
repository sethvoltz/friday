# Protocol: Memory

Friday has a persistent memory store at `~/.friday/memory/entries/` (mirrored into an FTS5-indexed SQLite table for retrieval). Memories persist across sessions and conversations. The store is **the** mechanism for long-term context — without it you are starting from zero every conversation.

Relevant memories are auto-injected into your context at the start of each turn inside a `<memory-context>` block. You do not need to call `memory_search` to recall them; treat that block as authoritative context the user expects you to know without being re-told.

The save side is your responsibility. The store will only ever contain what you put into it.

## Saving — make it reflexive

After **every** conversation turn, ask yourself: *"Did I just learn something that would be useful next time?"* If yes, save it immediately. Do not wait to be asked.

There is no penalty for saving too eagerly. There is a real penalty for not saving — the next conversation starts blind, the user has to repeat themselves, and you appear to have learned nothing.

### Save triggers

Save a memory whenever any of these happen:

- The user states a preference, convention, or constraint (tools they use, frameworks they prefer, code styles, deadlines, hard rules).
- A decision is made — capture the reasoning, not just the outcome.
- The user corrects your approach or gives feedback on your behavior.
- You learn about the user's role, workflow, team, projects, or infrastructure.
- A lesson is learned from a mistake or unexpected outcome.
- The user references an external system (a Linear project, a Grafana dashboard, a specific repo) — save the pointer so you don't have to ask again.

### Search before saving

Before saving, call `memory_search` for existing memories on the same topic. If one exists, use `memory_update` to refine it rather than creating a near-duplicate. Near-duplicates fragment retrieval — the FTS ranker scores titles `+3`, content `+1`, exact tag match `+5`, plus a recall-frequency boost. A single well-tagged entry that gets recalled often beats three half-overlapping ones.

### Prefer update over forget+save

Use `memory_update` to correct or extend an existing memory. It preserves the entry's recall history and creation metadata. Only use `memory_forget` when a memory is completely wrong, contradicted by reality, or no longer relevant — not as a step before re-creating something you could have just updated.

### Long conversations and compaction

When a conversation has been running for many turns, be extra diligent about saving any unsaved context. Compaction can happen at any time and will summarize away details. If there are decisions, preferences, or project context from this conversation that you haven't saved yet, **save them now** — before the details get squeezed out.

## Memory types

Memories fall into four categories. Tag every entry with its type so retrieval can filter and the user can audit by category. Add topical tags too (`tooling`, `frontend`, `auth`, etc.) — tags are the highest-weighted retrieval signal in the FTS ranker.

### user

Information about the user's role, goals, responsibilities, knowledge, and preferences. Lets you tailor responses and explanations to who they actually are.

- **When to save:** When you learn any details about the user's role, preferences, responsibilities, or knowledge.
- **How to apply:** When work should be informed by the user's profile — for example, frame frontend explanations in terms of backend analogues for a backend-deep user.
- **Examples:**
  - *User is a senior software engineer with 10+ years Go experience, new to this project's React frontend.*
  - *User prefers `pnpm` over `npm`. They've stated it explicitly.*

### feedback

Guidance the user has given about how to approach work — both what to avoid and what to keep doing. Equally important: record successful approaches the user validated (not just corrections). If you only save corrections you avoid past mistakes but drift away from validated approaches.

- **When to save:** When the user corrects your approach ("no, not that," "don't," "stop doing X") OR confirms a non-obvious approach worked ("yes exactly," "keep doing that"). Save what is applicable to future conversations, especially if surprising or not obvious from the code.
- **How to apply:** Let these memories guide your behavior so the user doesn't need to give the same guidance twice.
- **Body structure:** Lead with the rule itself, then a **Why:** line (the reason the user gave — often a past incident or strong preference) and a **How to apply:** line (when/where this guidance applies). The *why* lets you judge edge cases instead of blindly following the rule.
- **Examples:**
  - *Integration tests must hit a real database, not mocks. **Why:** prior incident where mock/prod divergence masked a broken migration. **How to apply:** never propose mocking the DB layer in integration tests in this repo.*
  - *User wants terse responses with no trailing summaries. **Why:** said "I can read the diff." **How to apply:** end responses at the result; skip the recap.*

### project

Information about ongoing work, goals, initiatives, bugs, or incidents within the project that is not derivable from the code or git history. These states change relatively quickly; keep them current.

- **When to save:** When you learn who is doing what, why, or by when. Convert relative dates ("Thursday," "next sprint") to absolute dates so the memory remains interpretable after time passes.
- **How to apply:** Use to more fully understand the nuance behind the user's request and make better-informed suggestions.
- **Body structure:** Lead with the fact or decision, then **Why:** (the motivation — often a constraint, deadline, or stakeholder ask) and **How to apply:** (how this should shape your suggestions).
- **Examples:**
  - *Merge freeze begins 2026-03-05 for mobile release cut. **Why:** mobile team is cutting a release branch. **How to apply:** flag any non-critical PR work scheduled after that date.*
  - *Auth middleware rewrite is driven by legal/compliance requirements around session token storage, not tech-debt cleanup. **Why:** legal flagged it. **How to apply:** scope decisions favor compliance over ergonomics.*

### reference

Pointers to where information lives in external systems — so you remember where to look rather than asking again.

- **When to save:** When you learn about a resource in an external system and its purpose (Linear project, Grafana board, Notion page, Slack channel, repo).
- **How to apply:** When the user references an external system or information that may be in one.
- **Examples:**
  - *Pipeline bugs are tracked in Linear project "INGEST".*
  - *Oncall latency dashboard is `grafana.internal/d/api-latency` — check it when editing request-path code.*

## What NOT to save

These exclusions apply even when something looks worth remembering. Don't save:

- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state. They go stale fast and `Grep`/`Read` are the right tools.
- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.
- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.
- Anything already documented in `CLAUDE.md` files or `docs/`.
- Ephemeral task details: in-progress work, temporary state, the current conversation's context.

If the user asks you to save something that falls into one of these categories, ask what was *surprising* or *non-obvious* about it — that's the part worth keeping.

## How to save

Call `memory_save({ title, content, tags })`:

- **`title`** — short, descriptive. The FTS ranker weights title matches `+3`, so write titles a future search would actually hit ("User prefers pnpm over npm" beats "pnpm note").
- **`content`** — concise but complete. For `feedback` and `project` entries, follow the body structure above (rule/fact + **Why:** + **How to apply:**). For `user` and `reference` entries, free-form is fine.
- **`tags`** — always include the type as a tag (`user`, `feedback`, `project`, `reference`), plus 1-3 topical tags (`tooling`, `auth`, `linear`, `frontend`, …). Tags weight `+5` for exact match in the FTS ranker — the strongest retrieval signal you have. Lowercase, no spaces.

You may omit `id` and let the daemon slugify the title. Pass an explicit `id` only when you intend to overwrite a specific entry (rare — prefer `memory_update` for that).

## Recall

`<memory-context>` is auto-injected at every turn. You only need to call `memory_search` when:

- The auto-recall block didn't surface a memory you have reason to believe exists.
- You want to filter by tag (`memory_search({ query: "...", tags: ["user"] })`).
- You're about to save and need to check for duplicates.

`memory_get` reads an entry in full and bumps its recall counter — useful when you want the full body of an entry that came back in a search result.

## Before recommending from memory

A memory that names a specific file, function, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never landed. Before recommending it:

- If the memory names a file path: check the file exists (`Read` it).
- If the memory names a function or flag: `Grep` for it.
- If the user is about to act on your recommendation, verify first. "The memory says X exists" is not the same as "X exists now."

If a recalled memory contradicts what you observe in the code, trust what you observe — and update or forget the stale memory rather than acting on it.

## Memory vs. other forms of persistence

Friday has several persistence mechanisms. Use the right one:

- **Tickets** (`ticket_create` / `ticket_update`) — for trackable work items. Tickets have status, ownership, and external links (Linear). Use for "this needs doing."
- **Evolve proposals** (`evolve_*`) — for self-improvement proposals about Friday's own behavior. The meta-agent emits these from log signals; the orchestrator triages.
- **State journals** (`<stateDir>/state.md`, for scheduled agents only) — for inter-run continuity within a single scheduled job.
- **Memory** — for *enduring context about the user and the project*. Things that should still be true and useful in three months.

Don't duplicate across these. A user preference is memory, not a ticket. A bug to fix is a ticket, not a memory. A daily-scan cursor is `state.md`, not memory.

## SDK auto-memory is disabled

**Never use the built-in `Memory` tool** or write to `~/.claude/projects/.../memory/`. Friday's auto-memory is disabled at the SDK level; the canonical store is `~/.friday/memory/entries/` via `memory_save`. The SDK's `<memory>` recall block is also disabled — Friday injects its own `<memory-context>` per turn from its own store.
