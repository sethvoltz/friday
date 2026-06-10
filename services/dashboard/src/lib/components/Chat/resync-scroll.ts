/**
 * Chase the bottom of a scroller across a bounded window of asynchronous
 * post-resync content growth. Extracted from ChatShell so the loop's
 * behavior can be pinned at the unit-test layer (DOM-mocked) without
 * mounting the full chat shell.
 *
 * Why it exists: when ChatShell first loads an agent (or opens a past
 * session), it does a single `scrollTop = scrollHeight` write after
 * `loadAgentTurns` resolves. But `loadAgentTurns` resolves only on the
 * cached-transcript first-paint + inflight-probe; the canonical Zero
 * blocks snapshot arrives moments later via `applyZeroBlocks` and grows
 * the rendered list below the user's just-set scroll position. The
 * persistent ResizeObserver on `.list` falls into the anchor-restore
 * branch (its `pinnedToBottom && turnActive` gate is false outside an
 * active turn), so content appended below the anchor leaves the user
 * pinned to the OLD bottom — typically about half a turn short of the
 * actual bottom.
 *
 * The chase loop keeps `scrollTop = scrollHeight` for a brief window so
 * each round of late content (Zero snapshot, image / iframe loads,
 * mermaid SVG mount, KaTeX layout, shiki tokenizer settle) is followed
 * to the new bottom. One-shot, NOT sticky: aborts on direct user input
 * (wheel / touchmove / keydown) and on `abort()` from the caller (used
 * to invalidate the chase on agent / session switch).
 */
export interface ResyncChaseTarget {
  scrollTop: number;
  readonly scrollHeight: number;
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface ResyncChaseDeps {
  /** Returns a strictly-increasing timestamp in milliseconds. */
  now: () => number;
  /** Schedule a callback for the next animation frame. Returns a handle. */
  raf: (cb: () => void) => number;
  /** Optional handle-cancel for tests that need to drop pending frames. */
  cancelRaf?: (handle: number) => void;
  /** Time budget in ms. Defaults to 800. */
  durationMs?: number;
  /** Called once when the chase has ended (deadline, abort, or input). */
  onEnd?: (reason: "deadline" | "aborted" | "input") => void;
}

export interface ResyncChaseHandle {
  /** Abort the chase. Idempotent. */
  abort: () => void;
  /** True until the chase exits (deadline, abort, or input). */
  readonly active: boolean;
}

const CANCEL_EVENTS = ["wheel", "touchmove", "keydown"] as const;

/**
 * `ResyncChaseTarget` adapter for an INNER scroller element
 * (spike/chat-inner-scroller). scrollTop/scrollHeight and the
 * cancel-input events all live on the one element, so this is a thin
 * pass-through — the element already has the shape the chase loop wants.
 */
export function makeElementChaseTarget(el: HTMLElement): ResyncChaseTarget {
  return {
    get scrollTop() {
      return el.scrollTop;
    },
    set scrollTop(v: number) {
      el.scrollTop = v;
    },
    get scrollHeight() {
      return el.scrollHeight;
    },
    addEventListener(type, listener, options) {
      el.addEventListener(type, listener, options);
    },
    removeEventListener(type, listener) {
      el.removeEventListener(type, listener);
    },
  };
}

export function chaseScrollBottom(
  target: ResyncChaseTarget,
  deps: ResyncChaseDeps,
): ResyncChaseHandle {
  const duration = deps.durationMs ?? 800;
  const deadline = deps.now() + duration;
  let active = true;
  let exitReason: "deadline" | "aborted" | "input" = "deadline";
  let pendingRaf: number | null = null;

  const onInput = (): void => {
    if (!active) return;
    exitReason = "input";
    end();
  };

  function end(): void {
    if (!active) return;
    active = false;
    for (const evt of CANCEL_EVENTS) target.removeEventListener(evt, onInput);
    if (pendingRaf !== null && deps.cancelRaf) {
      deps.cancelRaf(pendingRaf);
      pendingRaf = null;
    }
    deps.onEnd?.(exitReason);
  }

  function step(): void {
    pendingRaf = null;
    if (!active) return;
    target.scrollTop = target.scrollHeight;
    if (deps.now() >= deadline) {
      end();
      return;
    }
    pendingRaf = deps.raf(step);
  }

  for (const evt of CANCEL_EVENTS) {
    target.addEventListener(evt, onInput, { passive: true });
  }
  pendingRaf = deps.raf(step);

  return {
    abort: () => {
      if (!active) return;
      exitReason = "aborted";
      end();
    },
    get active() {
      return active;
    },
  };
}
