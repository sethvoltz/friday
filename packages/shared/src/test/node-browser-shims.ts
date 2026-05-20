/**
 * Side-effect import that installs the minimum set of browser globals
 * `@rocicorp/zero` reaches for when run in Node. ESM imports are
 * hoisted, so a shim block in the same file as `import { Zero }`
 * runs AFTER Zero is already loaded — too late: Zero's
 * `idb-databases-store` reads `globalThis.localStorage` during the
 * client's IO setup. This module has no Zero dependency and runs its
 * side effects at the top of the import graph.
 *
 * `kvStore: "mem"` is the documented Node-side option, but Zero's
 * `replicache` layer still references `localStorage` for the
 * `profileId` lookup (`replicache/src/persist/idb-databases-store.js`).
 * The shim is intentionally minimal — Zero only calls `getItem` /
 * `setItem`. Wider browser-API coverage (navigator, etc.) hasn't been
 * needed; add only on demand to keep the test seam small.
 */

type StorageShim = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
};

const g = globalThis as unknown as { localStorage?: StorageShim };
if (!g.localStorage) {
  const m = new Map<string, string>();
  g.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => {
      m.set(k, String(v));
    },
    removeItem: (k) => {
      m.delete(k);
    },
    clear: () => m.clear(),
  };
}
