/**
 * Tests for assembleSections — the pure builder that decides which palette
 * sections are visible, in what order, with which items flagged "current",
 * and how the fuzzy filter narrows results. The bugs that would land here
 * (wrong section order on chat vs. non-chat routes, stale recents
 * referencing deleted agents, the active route not flagged as current)
 * all live in this function, so the assertions pin user-visible contract:
 * exact section headings, exact item ids, the current flag, and the
 * specific id that should come first under a query.
 */
import { describe, expect, it } from "vitest";
import { assembleSections, flattenSections } from "./items";
import type { AgentInfo } from "$lib/stores/chat.svelte";
import type { RecentEntry } from "./store.svelte";

const noop = () => {};

function agents(): AgentInfo[] {
  return [
    { name: "friday", type: "orchestrator", status: "idle" },
    {
      name: "alice",
      type: "helper",
      status: "working",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-14T00:00:00Z",
    },
    {
      name: "bob",
      type: "builder",
      status: "idle",
      createdAt: "2026-05-12T00:00:00Z",
      updatedAt: "2026-05-13T00:00:00Z",
    },
  ];
}

function baseOpts() {
  return {
    agents: agents(),
    isChat: false,
    query: "",
    recents: [] as RecentEntry[],
    userMode: "dark" as const,
    currentPath: "/dashboard",
    onSetMode: noop,
  };
}

describe("assembleSections — section order", () => {
  it("on chat routes, Agents comes before Navigation", () => {
    const sections = assembleSections({
      ...baseOpts(),
      isChat: true,
      currentPath: "/",
    });
    const ids = sections.map((s) => s.id);
    // Recent is omitted (empty); Agents-before-Nav is the load-bearing claim.
    expect(ids).toEqual(["agents", "nav", "settings"]);
  });

  it("on non-chat routes, Navigation comes before Agents", () => {
    const sections = assembleSections({ ...baseOpts(), isChat: false });
    expect(sections.map((s) => s.id)).toEqual(["nav", "agents", "settings"]);
  });

  it("hides the Recent section when no recents exist", () => {
    const sections = assembleSections(baseOpts());
    expect(sections.find((s) => s.id === "recent")).toBeUndefined();
  });

  it("shows the Recent section first when populated (empty query)", () => {
    const recents: RecentEntry[] = [
      { kind: "page", id: "/tickets", ts: 1000 },
    ];
    const sections = assembleSections({ ...baseOpts(), recents });
    expect(sections[0].id).toBe("recent");
    expect(sections[0].items[0].label).toBe("Tickets");
  });
});

describe("assembleSections — current-item flag", () => {
  it("flags the active page in the Nav section", () => {
    const sections = assembleSections({
      ...baseOpts(),
      currentPath: "/tickets",
    });
    const nav = sections.find((s) => s.id === "nav")!;
    const tickets = nav.items.find((i) => i.id === "/tickets")!;
    const dashboard = nav.items.find((i) => i.id === "/dashboard")!;
    expect(tickets.current).toBe(true);
    expect(dashboard.current).toBe(false);
  });

  it("flags the orchestrator as current on '/'", () => {
    const sections = assembleSections({
      ...baseOpts(),
      isChat: true,
      currentPath: "/",
    });
    const agentsSec = sections.find((s) => s.id === "agents")!;
    const friday = agentsSec.items.find((i) => i.id === "friday")!;
    expect(friday.current).toBe(true);
    // Non-active agent must NOT be flagged
    const alice = agentsSec.items.find((i) => i.id === "alice")!;
    expect(alice.current).toBe(false);
  });

  it("flags a session agent as current on /sessions/<name>", () => {
    const sections = assembleSections({
      ...baseOpts(),
      isChat: true,
      currentPath: "/sessions/alice",
    });
    const agentsSec = sections.find((s) => s.id === "agents")!;
    expect(agentsSec.items.find((i) => i.id === "alice")!.current).toBe(true);
    expect(agentsSec.items.find((i) => i.id === "friday")!.current).toBe(false);
  });

  it("flags the matching theme setting based on userMode", () => {
    const sections = assembleSections({
      ...baseOpts(),
      userMode: "light",
    });
    const settings = sections.find((s) => s.id === "settings")!;
    const light = settings.items.find((i) => i.id === "theme.light")!;
    const dark = settings.items.find((i) => i.id === "theme.dark")!;
    const system = settings.items.find((i) => i.id === "theme.system")!;
    expect(light.current).toBe(true);
    expect(dark.current).toBe(false);
    expect(system.current).toBe(false);
  });

  it("flags 'Follow system' as current when userMode is 'system'", () => {
    const sections = assembleSections({
      ...baseOpts(),
      userMode: "system",
    });
    const settings = sections.find((s) => s.id === "settings")!;
    expect(
      settings.items.find((i) => i.id === "theme.system")!.current,
    ).toBe(true);
  });
});

describe("assembleSections — Agents sort", () => {
  it("pins the orchestrator first, then sorts others by updatedAt desc", () => {
    const sections = assembleSections({
      ...baseOpts(),
      isChat: true,
      currentPath: "/",
    });
    const ids = sections
      .find((s) => s.id === "agents")!
      .items.map((i) => i.id);
    // alice's updatedAt 2026-05-14 > bob's 2026-05-13
    expect(ids).toEqual(["friday", "alice", "bob"]);
  });

  it("synthesizes an orchestrator row when none exists in the agent list", () => {
    const sections = assembleSections({
      ...baseOpts(),
      isChat: true,
      currentPath: "/",
      agents: [
        { name: "alice", type: "helper", status: "idle" },
      ],
    });
    const agentsSec = sections.find((s) => s.id === "agents")!;
    expect(agentsSec.items[0].id).toBe("friday");
    expect(agentsSec.items[0].label).toBe("Friday");
  });

  it("sinks archived agents below live ones even when more recently updated", () => {
    // `zed` is the most recently updated but archived. `alice`/`bob` are
    // live. Archived must come last, regardless of recency.
    const sections = assembleSections({
      ...baseOpts(),
      isChat: true,
      currentPath: "/",
      agents: [
        { name: "friday", type: "orchestrator", status: "idle" },
        {
          name: "zed",
          type: "helper",
          status: "archived",
          updatedAt: "2026-05-15T00:00:00Z",
        },
        {
          name: "alice",
          type: "helper",
          status: "working",
          updatedAt: "2026-05-14T00:00:00Z",
        },
        {
          name: "bob",
          type: "builder",
          status: "idle",
          updatedAt: "2026-05-13T00:00:00Z",
        },
      ],
    });
    const ids = sections
      .find((s) => s.id === "agents")!
      .items.map((i) => i.id);
    expect(ids).toEqual(["friday", "alice", "bob", "zed"]);
  });

  it("ranks live + recent agents above archived under a fuzzy query", () => {
    // Both agents share the substring "ali". `alice` is live + recent;
    // `alice_archived` is archived. The bias must float the live one
    // even though fuzzysort would otherwise rank them by match quality
    // alone (which is identical here).
    const sections = assembleSections({
      ...baseOpts(),
      query: "ali",
      agents: [
        { name: "friday", type: "orchestrator", status: "idle" },
        {
          name: "alice",
          type: "helper",
          status: "idle",
          updatedAt: "2026-05-14T00:00:00Z",
        },
        {
          name: "alice_archived",
          type: "helper",
          status: "archived",
          updatedAt: "2026-05-15T00:00:00Z",
        },
      ],
    });
    const agentsSec = sections.find((s) => s.id === "agents")!;
    const ids = agentsSec.items.map((i) => i.id);
    const aliceIdx = ids.indexOf("alice");
    const archivedIdx = ids.indexOf("alice_archived");
    expect(aliceIdx).toBeGreaterThanOrEqual(0);
    expect(archivedIdx).toBeGreaterThanOrEqual(0);
    expect(aliceIdx).toBeLessThan(archivedIdx);
  });
});

describe("assembleSections — recents hydration", () => {
  it("drops recent entries whose source no longer exists", () => {
    const recents: RecentEntry[] = [
      { kind: "agent", id: "ghost", ts: 1000 }, // agent not in list
      { kind: "page", id: "/dashboard", ts: 1001 },
      { kind: "agent", id: "alice", ts: 1002 },
    ];
    const sections = assembleSections({ ...baseOpts(), recents });
    const recent = sections.find((s) => s.id === "recent")!;
    const surfaced = recent.items.map((i) => `${i.kind}:${i.id}`);
    expect(surfaced).toEqual(["page:/dashboard", "agent:alice"]);
    expect(surfaced).not.toContain("agent:ghost");
  });

  it("hides Recent entirely when no recents survive hydration", () => {
    const recents: RecentEntry[] = [
      { kind: "agent", id: "ghost", ts: 1000 },
    ];
    const sections = assembleSections({ ...baseOpts(), recents });
    expect(sections.find((s) => s.id === "recent")).toBeUndefined();
  });
});

describe("assembleSections — fuzzy query", () => {
  it("filters Nav to the matching page and ranks it first", () => {
    const sections = assembleSections({ ...baseOpts(), query: "tic" });
    const nav = sections.find((s) => s.id === "nav")!;
    expect(nav.items.length).toBeGreaterThan(0);
    expect(nav.items[0].id).toBe("/tickets");
  });

  it("hides sections whose items are all filtered out", () => {
    const sections = assembleSections({ ...baseOpts(), query: "tic" });
    // "tic" doesn't match any agent name or theme setting.
    expect(sections.find((s) => s.id === "agents")).toBeUndefined();
    expect(sections.find((s) => s.id === "settings")).toBeUndefined();
  });

  it("returns no sections when nothing matches", () => {
    const sections = assembleSections({
      ...baseOpts(),
      query: "zzzzzzzz-no-match",
    });
    expect(sections).toEqual([]);
  });

  it("hides Recent when a query is active even if recents exist", () => {
    const recents: RecentEntry[] = [
      { kind: "page", id: "/dashboard", ts: 1000 },
    ];
    const sections = assembleSections({
      ...baseOpts(),
      query: "ticket",
      recents,
    });
    expect(sections.find((s) => s.id === "recent")).toBeUndefined();
  });

  it("decorates the matched label with labelParts", () => {
    const sections = assembleSections({ ...baseOpts(), query: "tic" });
    const tickets = sections
      .find((s) => s.id === "nav")!
      .items.find((i) => i.id === "/tickets")!;
    expect(tickets.labelParts).toBeDefined();
    // The matched substring is "Tic" at the start of "Tickets".
    const matched = tickets
      .labelParts!.filter((p) => p.match)
      .map((p) => p.text)
      .join("");
    expect(matched.toLowerCase()).toBe("tic");
  });
});

describe("flattenSections", () => {
  it("returns items in display order across sections (drives Ctrl-1..9)", () => {
    const sections = assembleSections({
      ...baseOpts(),
      isChat: true,
      currentPath: "/",
    });
    const flat = flattenSections(sections);
    // First section is agents (chat route); first item is the orchestrator.
    expect(flat[0].id).toBe("friday");
    // Section seam: after the last agent comes the first nav item (Chat).
    const lastAgentIdx = flat.findIndex((it) => it.id === "bob");
    expect(flat[lastAgentIdx + 1].id).toBe("/");
  });
});
