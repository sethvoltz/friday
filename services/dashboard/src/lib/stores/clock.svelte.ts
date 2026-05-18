// Single shared wall-clock tick. Reactive consumers read `clock.now` from
// inside any rune or template; the tick fires once per minute, aligned to
// the next local minute boundary so all relative timestamps flip together.
//
// One timer for the whole dashboard — not per-component setInterval — so
// long chats with hundreds of bubbles don't pay N timers' worth of wakeups.
//
// Backgrounded-tab safety: browsers throttle setTimeout in inactive tabs,
// so a tab that slept through midnight would render a stale "Today" until
// the throttled timer eventually drained. We listen for `visibilitychange`
// and rehydrate the clock + reschedule the next tick the moment the tab
// becomes visible again.

class Clock {
  now = $state<number>(Date.now());
}

export const clock = new Clock();

let pending: ReturnType<typeof setTimeout> | null = null;

function tick() {
  pending = null;
  clock.now = Date.now();
  schedule();
}

function schedule() {
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
  // Align to the next wall-clock minute so "2:14 PM" → "2:15 PM" flips when
  // the user's clock actually says 2:15, not 60s after the page loaded.
  const ms = Date.now();
  const delay = 60_000 - (ms % 60_000);
  pending = setTimeout(tick, delay);
}

/** Force `clock.now` to the current wall-clock and reschedule the next
 *  tick. Called on tab-visibility-becomes-visible and exported for tests. */
export function rehydrateClock(): void {
  clock.now = Date.now();
  schedule();
}

let started = false;
/** Idempotent. The module auto-starts when `window` exists; tests can also
 *  invoke explicitly. */
export function startClock(): void {
  if (started) return;
  started = true;
  schedule();
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") rehydrateClock();
    });
  }
}

if (typeof window !== "undefined") {
  startClock();
}
