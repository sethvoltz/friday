/**
 * Transition queue — the per-agent-name serialized queue every Transition
 * funnels through (CONTEXT.md → "Agent turn lifecycle").
 *
 * This is the agent-keyed successor to the per-worker `ipcChain` that used to
 * live as a closure-local resolved-promise chain inside each `spawnWorker`
 * (the predecessor serialized only one worker generation's IPC channel and
 * died with the worker). Keying by agent NAME instead of worker
 * instance means cross-generation Transitions for the same agent still apply
 * in strict arrival order — e.g. a stale generation's `exit` Transition and
 * the next generation's `spawn` Transition can no longer interleave.
 *
 * Invariants:
 *   - Transitions for ONE agent name run strictly in enqueue order; the next
 *     Transition does not start until the previous one's promise settles.
 *   - Transitions for DIFFERENT agent names are independent and may overlap.
 *   - A Transition that throws/rejects does NOT wedge the queue for its key:
 *     the chain catches and logs, then proceeds to the next Transition.
 *   - The chain is self-pruning. When a Transition settles and nothing else
 *     has been chained after it (it is still the queue's tail), the map entry
 *     is removed so an idle agent name leaves no resident promise. A fresh
 *     `enqueueTransition` for that name simply starts a new chain.
 *
 * Deadlock note (FRI-145 V3): NEVER `await enqueueTransition(sameKey, …)`
 * from inside a Transition already running on that key's chain — the awaited
 * promise can only resolve after the current Transition returns, so the chain
 * would deadlock on itself. The watchdog's `stall` Transition is enqueued
 * fire-and-forget for exactly this reason. Cross-key awaits are fine.
 */

import { logger } from "../log.js";

/**
 * Module-level chain map. Each value is the tail promise of that agent name's
 * Transition chain — the promise the NEXT enqueue chains onto. Absent when the
 * agent name has no in-flight or pending Transition (the chain self-pruned).
 *
 * Exported (read-only intent) so tests can assert pruning without reaching
 * through a getter; production code must mutate it only via the functions in
 * this module.
 */
export const transitionQueues = new Map<string, Promise<void>>();

/**
 * Enqueue `transition` onto `name`'s serialized Transition chain. Returns the
 * promise for THIS transition's completion (resolves once `transition` settles,
 * regardless of whether it threw — a thrown error is logged, not re-thrown, so
 * a fire-and-forget caller never produces an unhandled rejection and the chain
 * never wedges).
 *
 * Fire-and-forget callers (the IPC `child.on("message")` handler, the watchdog
 * `stall` Transition) ignore the return; callers that need to sequence their
 * own side effects after the Transition resolves can await it — but only from
 * a DIFFERENT key's context (see the deadlock note above).
 */
export function enqueueTransition(
  name: string,
  transition: () => void | Promise<void>,
): Promise<void> {
  const prev = transitionQueues.get(name) ?? Promise.resolve();
  // The chain swallows the transition's error so one bad Transition can't wedge
  // the queue for this key. We capture the settled promise as the new tail and
  // self-prune once it settles iff no later enqueue replaced the tail.
  const next = prev.then(() =>
    Promise.resolve()
      .then(transition)
      .catch((err: unknown) => {
        logger.log("error", "transition-queue.transition.error", {
          agent: name,
          err: err instanceof Error ? err.message : String(err),
        });
      }),
  );
  transitionQueues.set(name, next);
  // Self-prune: when THIS link settles, if it is still the tail (nothing was
  // chained after it) drop the map entry so an idle name leaves no resident
  // promise. Must compare identity — a later enqueue swaps the tail and this
  // link's settle handler must NOT delete the live chain.
  void next.then(() => {
    if (transitionQueues.get(name) === next) {
      transitionQueues.delete(name);
    }
  });
  return next;
}

/**
 * Result-bearing enqueue (FRI-145 M4). Same strict-serialization +
 * non-wedging chain as {@link enqueueTransition}, but the RETURNED promise
 * resolves/rejects with `transition`'s actual outcome — so an awaiting caller
 * sees a real value or a real error.
 *
 * The chain TAIL (what the next enqueue serializes behind) still swallows the
 * error, exactly as `enqueueTransition` does, so one rejecting Transition can
 * never wedge the queue for its key. The caller's view (the returned promise)
 * and the chain's view (the resident tail) are deliberately decoupled.
 *
 * Used by the archive channel: `lifecycle.archiveAgent` awaits this so the
 * orchestrator-not-archivable `IllegalTransitionError` propagates to the REST
 * endpoint exactly as the pre-M4 direct `registry.archiveAgent` call did, while
 * a concurrent archive of a DIFFERENT agent still proceeds independently and a
 * failed archive doesn't poison this agent's later Transitions.
 *
 * Deadlock note (V3): like `enqueueTransition`, NEVER `await` this from inside
 * a Transition already running on the SAME key — only external callers (the
 * REST handler, the LISTEN handler, boot recovery, the auditor, the installer)
 * await it, none of which run on the per-agent chain.
 */
export function enqueueTransitionResult<T>(
  name: string,
  transition: () => T | Promise<T>,
): Promise<T> {
  const prev = transitionQueues.get(name) ?? Promise.resolve();
  // The caller's result is captured from THIS run; the chain tail derives from
  // the same run but swallows the error so the queue never wedges.
  let settle: (value: T | PromiseLike<T>) => void;
  let reject: (reason: unknown) => void;
  const result = new Promise<T>((res, rej) => {
    settle = res;
    reject = rej;
  });
  const next = prev.then(() =>
    Promise.resolve()
      .then(transition)
      .then(
        (value) => {
          settle(value);
        },
        (err: unknown) => {
          // Surface the real error to the awaiting caller, but keep the chain
          // tail resolved so later Transitions for this key still run.
          reject(err);
          logger.log("error", "transition-queue.transition.error", {
            agent: name,
            err: err instanceof Error ? err.message : String(err),
          });
        },
      ),
  );
  transitionQueues.set(name, next);
  void next.then(() => {
    if (transitionQueues.get(name) === next) {
      transitionQueues.delete(name);
    }
  });
  return result;
}

/**
 * Test-only reset hook. Clears all chains so one test file's pending tails
 * don't bleed into the next. Production code never calls this.
 */
export function _resetTransitionQueuesForTest(): void {
  transitionQueues.clear();
}
