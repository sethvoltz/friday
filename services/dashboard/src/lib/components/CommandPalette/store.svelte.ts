import { KEYS, loadJSON, saveJSON } from "$lib/stores/persistent";

export type RecentKind = "page" | "agent" | "setting";

export interface RecentEntry {
  kind: RecentKind;
  id: string;
  ts: number;
}

const RECENT_CAP = 6;

export class CommandPaletteState {
  open = $state(false);
  query = $state("");
  recents = $state<RecentEntry[]>([]);
  private hydrated = false;

  hydrate(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    const raw = loadJSON<RecentEntry[]>(KEYS.paletteRecent, []);
    if (!Array.isArray(raw)) return;
    this.recents = raw
      .filter(
        (r): r is RecentEntry =>
          !!r &&
          typeof r.id === "string" &&
          typeof r.ts === "number" &&
          (r.kind === "page" || r.kind === "agent" || r.kind === "setting"),
      )
      .slice(0, RECENT_CAP);
  }

  openPalette(): void {
    this.query = "";
    this.open = true;
  }

  closePalette(): void {
    this.open = false;
  }

  toggle(): void {
    if (this.open) this.closePalette();
    else this.openPalette();
  }

  pushRecent(entry: Omit<RecentEntry, "ts">): void {
    const next: RecentEntry = { ...entry, ts: Date.now() };
    const filtered = this.recents.filter(
      (r) => !(r.kind === next.kind && r.id === next.id),
    );
    this.recents = [next, ...filtered].slice(0, RECENT_CAP);
    saveJSON(KEYS.paletteRecent, this.recents);
  }
}

export const commandPalette = new CommandPaletteState();
