// Single shared wall-clock tick. Reactive consumers read `clock.now` from
// inside any rune or template; the tick fires once per minute, aligned to
// the next local minute boundary so all relative timestamps flip together.
//
// One timer for the whole dashboard — not per-component setInterval — so
// long chats with hundreds of bubbles don't pay N timers' worth of wakeups.

class Clock {
  now = $state<number>(Date.now());
}

export const clock = new Clock();

let started = false;

function tick() {
  clock.now = Date.now();
  schedule();
}

function schedule() {
  // Align to the next wall-clock minute so "2:14 PM" → "2:15 PM" flips when
  // the user's clock actually says 2:15, not 60s after the page loaded.
  const ms = Date.now();
  const delay = 60_000 - (ms % 60_000);
  setTimeout(tick, delay);
}

if (typeof window !== "undefined" && !started) {
  started = true;
  schedule();
}
