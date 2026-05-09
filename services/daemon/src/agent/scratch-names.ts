/**
 * Pronounceable, friendly kebab-case names for fresh scratch agents:
 * `scratch-<adj>-<noun>`. Words are deliberately short and unambiguous so the
 * full name fits in a sidebar row at a glance and is easy to say aloud
 * (e.g. "scratch-quiet-otter" rather than a base36 blob).
 *
 * Wordlist size = 32 × 32 = 1,024 unique pairs. Caller passes a `taken`
 * predicate so we can skip names already in the registry; on the off-chance
 * the user holds 1,024 scratch agents at once, we fall through to a numeric
 * suffix so we never loop forever.
 */

const ADJECTIVES = [
  "amber",
  "bold",
  "brisk",
  "calm",
  "clear",
  "cosy",
  "crisp",
  "dawn",
  "dusk",
  "eager",
  "easy",
  "fair",
  "fresh",
  "gentle",
  "golden",
  "happy",
  "honest",
  "kind",
  "lucky",
  "mellow",
  "neat",
  "noble",
  "patient",
  "plucky",
  "quick",
  "quiet",
  "ready",
  "rosy",
  "snug",
  "sunny",
  "swift",
  "warm",
];

const NOUNS = [
  "badger",
  "beacon",
  "breeze",
  "brook",
  "comet",
  "crane",
  "delta",
  "ember",
  "falcon",
  "feather",
  "ferry",
  "forest",
  "garden",
  "harbor",
  "heron",
  "island",
  "lantern",
  "ledge",
  "marble",
  "meadow",
  "moth",
  "otter",
  "pebble",
  "pine",
  "raven",
  "ridge",
  "river",
  "robin",
  "spruce",
  "swallow",
  "thicket",
  "willow",
];

export function generateScratchName(taken: (name: string) => boolean): string {
  // Try random pairs until we find a free one. With 1k combinations and
  // ~tens of agents at most, expected collisions are vanishingly rare; cap at
  // 50 attempts before falling through to a numeric tiebreaker.
  for (let i = 0; i < 50; i++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const name = `scratch-${adj}-${noun}`;
    if (!taken(name)) return name;
  }
  // Numeric tiebreaker for the ~impossible case where 50 random pairs all
  // collide. Monotonic suffix; loop is bounded by registry size.
  for (let n = 1; n < 10_000; n++) {
    const name = `scratch-${n}`;
    if (!taken(name)) return name;
  }
  // If even that fails, use a timestamp as a last-resort unique token.
  return `scratch-${Date.now().toString(36)}`;
}
