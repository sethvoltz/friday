import fuzzysort from "fuzzysort";
import {
  LayoutDashboard,
  MessageSquare,
  Ticket,
  CalendarClock,
  Brain,
  Sparkles,
  Wrench,
  ScrollText,
  Settings,
  Sun,
  Moon,
  Monitor,
  Inbox,
} from "lucide-svelte";
import type { AgentInfo } from "$lib/stores/chat.svelte";
import { agentIconFor } from "$lib/util/agent-icon";
import { PALETTES, type PaletteName } from "$lib/theme/palettes";
import type { ThemeKind } from "$lib/stores/theme.svelte";
import type { RecentEntry } from "./store.svelte";

type Icon = typeof Sun;

export interface PaletteItem {
  kind: "page" | "agent" | "setting";
  /** Stable id; recents key off (kind, id). pages → href, agents → name, settings → setting key. */
  id: string;
  label: string;
  /** Right-aligned dimmed secondary text (route path, agent type, etc.). */
  secondary?: string;
  icon: Icon;
  /** Optional CSS var name (e.g. "--agent-builder") that tints the leading icon. */
  iconColor?: string;
  /** For pages and agents — what to navigate to. */
  href?: string;
  /** For settings — invoke when selected. */
  action?: () => void;
  /** For agents — drives the status dot (`working`/`idle`/`stalled`/`error`/`archived`). */
  agentStatus?: string;
  /** For agents — `updatedAt` parsed to a unix-ms timestamp. Drives recency
   *  weighting; 0 when the row has no timestamp yet (SSE-synthesized
   *  entries pre-first-poll). */
  agentUpdatedMs?: number;
  /** Render a dimmed "current" pill. Selecting a current row is a no-op (closes the palette). */
  current?: boolean;
  /** Highlight spans for the label when filtered by query. */
  labelParts?: Array<{ text: string; match: boolean }>;
}

export interface PaletteSection {
  id: "recent" | "agents" | "nav" | "settings";
  heading: string;
  items: PaletteItem[];
}

interface NavSpec {
  href: string;
  label: string;
  icon: Icon;
}

/**
 * Mirrors the header nav in +layout.svelte. Order intentionally matches the
 * header so the palette's "Nav" section reads the same as the visible chrome.
 */
const NAV_SPECS: readonly NavSpec[] = [
  { href: "/", label: "Chat", icon: MessageSquare },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/tickets", label: "Tickets", icon: Ticket },
  { href: "/schedules", label: "Schedules", icon: CalendarClock },
  { href: "/memory", label: "Memory", icon: Brain },
  { href: "/evolve", label: "Evolve", icon: Sparkles },
  { href: "/skills", label: "Skills", icon: Wrench },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/mail", label: "Mail", icon: Inbox },
  { href: "/settings", label: "Settings", icon: Settings },
];

/** FRI-124: ⌘K Theme entries are a flat list — one "Sync with system"
 *  toggle + one entry per palette. Picking the toggle sets the user
 *  back to Sync mode preserving slot picks; picking a palette switches
 *  to Single mode + that palette. Each palette's icon comes from its
 *  intrinsic kind (Sun for light-kind palettes; Moon for dark-kind). */
type ThemePaletteAction = { type: "palette"; palette: PaletteName };
type ThemeSyncAction = { type: "sync" };
type ThemeAction = ThemePaletteAction | ThemeSyncAction;

interface ThemeSpec {
  id: string;
  label: string;
  icon: Icon;
  action: ThemeAction;
}

function iconForPalette(name: PaletteName): Icon {
  return PALETTES[name]?.kind === "dark" ? Moon : Sun;
}

function displayPaletteName(name: PaletteName): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function themeSpecs(): readonly ThemeSpec[] {
  const palettes = Object.keys(PALETTES) as PaletteName[];
  return [
    {
      id: "theme.sync",
      label: "Theme: Sync with system",
      icon: Monitor,
      action: { type: "sync" },
    },
    ...palettes.map<ThemeSpec>((name) => ({
      id: `theme.palette.${name}`,
      label: `Theme: ${displayPaletteName(name)}`,
      icon: iconForPalette(name),
      action: { type: "palette", palette: name },
    })),
  ];
}

function ageMs(a: AgentInfo): number {
  const t = a.updatedAt ?? a.createdAt;
  if (!t) return 0;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Multiplicative weight applied on top of fuzzysort's match score so
 * live + recent agents float above archived/stale ones at similar match
 * quality. We multiply rather than add because fuzzysort's `scoreFn`
 * pipeline runs the return value through `denormalizeScore` (a log-based
 * inverse-normalization) which produces `NaN` for negatives — so the
 * combined score must stay strictly in `(0, 1]`. Magnitudes here only
 * break ties / near-ties; a clearly better text match on an archived
 * agent still wins over a weak match on a live one.
 *
 *   ×0.5   archived agents
 *   ×0.95–1.0 recency: exponentially decaying bonus (half-life ~5 days)
 */
function agentWeight(a: PaletteItem, now: number): number {
  if (a.kind !== "agent") return 1;
  let w = 1;
  if (a.agentStatus === "archived") w *= 0.5;
  const t = a.agentUpdatedMs ?? 0;
  if (t > 0) {
    const days = Math.max(0, (now - t) / 86_400_000);
    w *= 0.95 + 0.05 * Math.exp(-days / 5);
  } else {
    w *= 0.95;
  }
  return w;
}

function isPageCurrent(href: string, currentPath: string): boolean {
  if (href === "/") {
    return currentPath === "/" || currentPath.startsWith("/sessions");
  }
  return currentPath === href || currentPath.startsWith(href + "/");
}

function activeAgentFor(currentPath: string): string {
  if (currentPath.startsWith("/sessions/")) {
    const rest = currentPath.slice("/sessions/".length);
    const slash = rest.indexOf("/");
    return slash >= 0 ? rest.slice(0, slash) : rest;
  }
  return "friday";
}

function buildNavItems(currentPath: string): PaletteItem[] {
  return NAV_SPECS.map((n) => ({
    kind: "page" as const,
    id: n.href,
    label: n.label,
    secondary: n.href,
    icon: n.icon,
    href: n.href,
    current: isPageCurrent(n.href, currentPath),
  }));
}

function buildAgentItems(agents: readonly AgentInfo[], currentPath: string): PaletteItem[] {
  const active = activeAgentFor(currentPath);
  const orchestrator = agents.find((a) => a.type === "orchestrator");
  // Composite sort for "others": live before archived (primary), then
  // most-recently-updated first (secondary), then alphabetical (stable
  // tiebreaker so adjacent unchanged rows don't shuffle between polls).
  const others = agents
    .filter((a) => a.type !== "orchestrator")
    .slice()
    .sort((a, b) => {
      const aArch = a.status === "archived" ? 1 : 0;
      const bArch = b.status === "archived" ? 1 : 0;
      if (aArch !== bArch) return aArch - bArch;
      return ageMs(b) - ageMs(a) || a.name.localeCompare(b.name);
    });

  const ordered: AgentInfo[] = [];
  if (orchestrator) ordered.push(orchestrator);
  else ordered.push({ name: "friday", type: "orchestrator", status: "idle" });
  ordered.push(...others);

  return ordered.map((a) => {
    const isOrch = a.type === "orchestrator";
    return {
      kind: "agent" as const,
      id: a.name,
      label: isOrch ? "Friday" : a.name,
      secondary: a.type,
      icon: agentIconFor(a.type),
      iconColor: `--agent-${a.type}`,
      href: isOrch ? "/" : `/sessions/${a.name}`,
      agentStatus: a.status,
      agentUpdatedMs: ageMs(a),
      current: isOrch ? active === "friday" : a.name === active,
    };
  });
}

function buildSettingItems(
  themeKind: ThemeKind,
  activePalette: PaletteName,
  onSetSync: () => void,
  onSetPalette: (name: PaletteName) => void,
): PaletteItem[] {
  return themeSpecs().map((s) => {
    const isCurrent =
      s.action.type === "sync" ? themeKind === "sync" : s.action.palette === activePalette;
    return {
      kind: "setting" as const,
      id: s.id,
      label: s.label,
      icon: s.icon,
      action:
        s.action.type === "sync"
          ? onSetSync
          : (
              (palette) => () =>
                onSetPalette(palette)
            )(s.action.palette),
      current: isCurrent,
    };
  });
}

function buildHighlight(
  label: string,
  indexes: readonly number[] | undefined,
): PaletteItem["labelParts"] {
  if (!indexes || indexes.length === 0) return undefined;
  const set = new Set(indexes);
  const parts: Array<{ text: string; match: boolean }> = [];
  let buf = "";
  let mode: boolean | null = null;
  for (let i = 0; i < label.length; i++) {
    const isMatch = set.has(i);
    if (mode === null) {
      mode = isMatch;
      buf = label[i];
    } else if (isMatch === mode) {
      buf += label[i];
    } else {
      parts.push({ text: buf, match: mode });
      mode = isMatch;
      buf = label[i];
    }
  }
  if (buf) parts.push({ text: buf, match: mode ?? false });
  return parts;
}

function filterByQuery(items: PaletteItem[], query: string, now: number): PaletteItem[] {
  if (!query.trim()) return items;
  const results = fuzzysort.go(query, items, {
    keys: ["label", "secondary"],
    threshold: -10000,
    limit: 50,
  });
  // fuzzysort already sorted by .score desc. Re-sort here with a
  // multiplicative agent weight on top so live + recent agents float
  // above archived/stale ones at similar match quality. We post-sort
  // (rather than using fuzzysort's `scoreFn` option) because the
  // library's pipeline pushes scoreFn results through a log-based
  // `denormalizeScore` that produces NaN for any return outside (0, 1].
  const weighted = results.map((r) => {
    const item = r.obj as PaletteItem;
    return { r, item, composite: r.score * agentWeight(item, now) };
  });
  weighted.sort((a, b) => b.composite - a.composite);
  return weighted.map(({ r, item }) => {
    // Prefer the label match for highlight; fall back to secondary if label missed.
    const labelHit = r[0];
    const indexes = labelHit && labelHit.target === item.label ? labelHit.indexes : undefined;
    return { ...item, labelParts: buildHighlight(item.label, indexes) };
  });
}

interface HydratedRecent {
  entry: RecentEntry;
  item: PaletteItem;
}

function hydrateRecents(
  recents: readonly RecentEntry[],
  nav: PaletteItem[],
  agents: PaletteItem[],
  settings: PaletteItem[],
): HydratedRecent[] {
  const out: HydratedRecent[] = [];
  const byKindId = new Map<string, PaletteItem>();
  for (const it of nav) byKindId.set(`page:${it.id}`, it);
  for (const it of agents) byKindId.set(`agent:${it.id}`, it);
  for (const it of settings) byKindId.set(`setting:${it.id}`, it);
  for (const r of recents) {
    const hit = byKindId.get(`${r.kind}:${r.id}`);
    if (hit) out.push({ entry: r, item: hit });
  }
  return out;
}

export interface AssembleOpts {
  agents: readonly AgentInfo[];
  isChat: boolean;
  query: string;
  recents: readonly RecentEntry[];
  themeKind: ThemeKind;
  activePalette: PaletteName;
  currentPath: string;
  onSetSync: () => void;
  onSetPalette: (name: PaletteName) => void;
}

export function assembleSections(opts: AssembleOpts): PaletteSection[] {
  const {
    agents,
    isChat,
    query,
    recents,
    themeKind,
    activePalette,
    currentPath,
    onSetSync,
    onSetPalette,
  } = opts;

  const navItems = buildNavItems(currentPath);
  const agentItems = buildAgentItems(agents, currentPath);
  const settingItems = buildSettingItems(themeKind, activePalette, onSetSync, onSetPalette);

  const trimmed = query.trim();
  const out: PaletteSection[] = [];

  if (!trimmed) {
    const hydrated = hydrateRecents(recents, navItems, agentItems, settingItems);
    if (hydrated.length > 0) {
      out.push({
        id: "recent",
        heading: "Recent",
        items: hydrated.map((h) => h.item),
      });
    }
    const sections: PaletteSection[] = [
      { id: "agents", heading: "Agents", items: agentItems },
      { id: "nav", heading: "Navigation", items: navItems },
      { id: "settings", heading: "Settings", items: settingItems },
    ];
    // On chat routes the user is reaching for agents first; elsewhere
    // they're reaching for pages first.
    const order: PaletteSection["id"][] = isChat
      ? ["agents", "nav", "settings"]
      : ["nav", "agents", "settings"];
    for (const id of order) {
      const sec = sections.find((s) => s.id === id);
      if (sec && sec.items.length > 0) out.push(sec);
    }
    return out;
  }

  const now = Date.now();
  const filteredAgents = filterByQuery(agentItems, trimmed, now);
  const filteredNav = filterByQuery(navItems, trimmed, now);
  const filteredSettings = filterByQuery(settingItems, trimmed, now);

  const sections: PaletteSection[] = [
    { id: "agents", heading: "Agents", items: filteredAgents },
    { id: "nav", heading: "Navigation", items: filteredNav },
    { id: "settings", heading: "Settings", items: filteredSettings },
  ];
  const order: PaletteSection["id"][] = isChat
    ? ["agents", "nav", "settings"]
    : ["nav", "agents", "settings"];
  for (const id of order) {
    const sec = sections.find((s) => s.id === id);
    if (sec && sec.items.length > 0) out.push(sec);
  }
  return out;
}

/**
 * Flatten section items in display order. Drives keyboard cursor + Ctrl-1..9
 * (the Nth visible row across all sections).
 */
export function flattenSections(sections: readonly PaletteSection[]): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const s of sections) for (const it of s.items) out.push(it);
  return out;
}
