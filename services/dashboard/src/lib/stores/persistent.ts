/**
 * Tiny SSR-safe localStorage helpers with namespaced keys.
 *
 * Why a helper rather than direct `localStorage` calls: SvelteKit renders the
 * layout server-side first, where `localStorage` is undefined. Wrapping every
 * access lets call sites stay readable without `typeof window` guards.
 */

const NS = "friday:";

export function loadJSON<T>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(NS + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
  } catch {
    // QuotaExceeded etc — drop silently. Callers expect best-effort.
  }
}

export function loadString(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(NS + key);
  } catch {
    return null;
  }
}

export function saveString(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(NS + key, value);
  } catch {
    // ignore
  }
}

export function removeKey(key: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(NS + key);
  } catch {
    // ignore
  }
}

export const KEYS = {
  theme: "theme",
  draft: (agent: string) => `draft:${agent}`,
  pinned: (agent: string) => `pinned:${agent}`,
  transcript: (agent: string) => `transcript:${agent}`,
  sendQueue: "sendQueue",
  paletteRecent: "palette:recent",
};
