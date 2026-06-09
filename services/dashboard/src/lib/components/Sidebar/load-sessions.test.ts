/**
 * Unit tests for the sidebar past-sessions fetch-with-retry helper
 * (FRI-162). These pin the AC1-AC3 logic at the layer the bug lives in —
 * the fetch + bounded-retry policy — without mounting the Svelte component:
 *
 *   AC1: a non-ok response AND a thrown fetch resolve to `{ ok: false }`
 *        (a distinguishable failure), NOT a successful empty list.
 *   AC2: a fail-then-succeed sequence resolves to the success array (the
 *        bounded retry self-heals a transient daemon hiccup).
 *   AC3: an ultimate failure after all attempts resolves to `{ ok: false }`
 *        so the caller can render the Retry affordance; the wrapper-level
 *        store-mutation seam is asserted in the component layer.
 *
 * The backoff sleep is injected as a no-op so the suite never sleeps for
 * real, and a captured sleep spy lets us assert the bounded retry count.
 */

import { describe, expect, it, vi } from "vitest";
import {
  applyLoadResult,
  loadPastSessionsWithRetry,
  type LoadSessionsResult,
  type SessionStoreSeam,
} from "./load-sessions";

const noSleep = () => Promise.resolve();

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function errResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: "daemon_error" }),
  } as unknown as Response;
}

describe("loadPastSessionsWithRetry (FRI-162)", () => {
  it("AC1: a sustained non-ok response resolves to { ok: false } after the bounded attempts, never a success", async () => {
    const fetchImpl = vi.fn(async () => errResponse(502));
    const sleep = vi.fn(noSleep);

    const result: LoadSessionsResult = await loadPastSessionsWithRetry("a", {
      attempts: 3,
      backoffMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    expect(result).toEqual({ ok: false });
    // Exhausted exactly `attempts` fetches.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledWith("/api/agents/a/sessions");
    // Backoff slept between attempts only (attempts - 1 times), with the
    // linear `backoffMs * attempt` schedule.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it("AC1: a thrown fetch (hard ECONNREFUSED) resolves to { ok: false }, never throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const result = await loadPastSessionsWithRetry("b", {
      attempts: 2,
      backoffMs: 5,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });

    expect(result).toEqual({ ok: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("AC2: a fail-then-succeed sequence resolves to the success array on the retry", async () => {
    const sessions = [{ sessionId: "s-a-past", firstTs: 1, lastTs: 2, turnCount: 2 }];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errResponse(502))
      .mockResolvedValueOnce(okResponse(sessions));

    const result = await loadPastSessionsWithRetry("a", {
      attempts: 3,
      backoffMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });

    expect(result).toEqual({ ok: true, sessions });
    // Stopped retrying once the success landed — exactly 2 fetches, not 3.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a thrown-then-succeed sequence also recovers (covers the ECONNREFUSED self-heal path)", async () => {
    const sessions = [{ sessionId: "s-a-cur", firstTs: 3, lastTs: 4, turnCount: 1 }];
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(okResponse(sessions));

    const result = await loadPastSessionsWithRetry("a", {
      attempts: 3,
      backoffMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });

    expect(result).toEqual({ ok: true, sessions });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a successful empty 200 is a successful empty load (NOT a failure, NOT retried)", async () => {
    // The daemon reads sessions straight from Postgres blocks (no
    // replication hop), so an empty array is a genuinely-empty agent — it
    // must resolve { ok: true, sessions: [] } on the FIRST attempt without
    // burning retries.
    const fetchImpl = vi.fn(async () => okResponse([]));

    const result = await loadPastSessionsWithRetry("empty", {
      attempts: 3,
      backoffMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });

    expect(result).toEqual({ ok: true, sessions: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a 200 whose body is not an array consumes an attempt and ultimately fails", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ error: "unexpected shape" }));

    const result = await loadPastSessionsWithRetry("weird", {
      attempts: 2,
      backoffMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });

    expect(result).toEqual({ ok: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("succeeds on the first attempt without sleeping when the daemon is up", async () => {
    const sessions = [{ sessionId: "s", firstTs: 1, lastTs: 2, turnCount: 1 }];
    const fetchImpl = vi.fn(async () => okResponse(sessions));
    const sleep = vi.fn(noSleep);

    const result = await loadPastSessionsWithRetry("up", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    expect(result).toEqual({ ok: true, sessions });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("applyLoadResult — store-mutation seam (FRI-162 AC1/AC3)", () => {
  function freshStore(): SessionStoreSeam {
    return { sidebarPastSessions: {}, sidebarSessionsError: {} };
  }

  it("AC1: a failure result sets the error flag and does NOT cache an empty list (failure ≠ empty)", () => {
    const store = freshStore();
    applyLoadResult(store, "a", { ok: false });

    expect(store.sidebarSessionsError["a"]).toBe(true);
    // The distinguishing assertion: a failed load must NOT look like a
    // genuinely-empty agent. The past-sessions slot stays untouched
    // (undefined), and the error flag carries the failure signal.
    expect(store.sidebarPastSessions["a"]).toBeUndefined();
  });

  it("a success result caches the array and clears any prior error flag", () => {
    const store = freshStore();
    // Seed a prior failure so we prove a subsequent success clears it.
    store.sidebarSessionsError["a"] = true;
    const sessions = [{ sessionId: "s-a-cur", firstTs: 1, lastTs: 2, turnCount: 2 }];

    applyLoadResult(store, "a", { ok: true, sessions });

    expect(store.sidebarPastSessions["a"]).toEqual(sessions);
    expect(store.sidebarSessionsError["a"]).toBe(false);
  });

  it("AC3: a fail-then-Retry-succeed sequence ends with rows cached and no error (mirrors the Retry click)", async () => {
    const store = freshStore();
    const sessions = [{ sessionId: "s-a-past", firstTs: 1, lastTs: 2, turnCount: 2 }];
    // Attempt 1: daemon down for the whole bounded run → failure.
    const downFetch = vi.fn(
      async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response,
    );
    applyLoadResult(
      store,
      "a",
      await loadPastSessionsWithRetry("a", {
        attempts: 2,
        backoffMs: 1,
        fetchImpl: downFetch as unknown as typeof fetch,
        sleep: () => Promise.resolve(),
      }),
    );
    expect(store.sidebarSessionsError["a"]).toBe(true);
    expect(store.sidebarPastSessions["a"]).toBeUndefined();

    // Retry: daemon now up → success clears the error and caches rows,
    // exactly what the submenu's Retry button drives via loadPastSessions.
    const upFetch = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => sessions }) as unknown as Response,
    );
    applyLoadResult(
      store,
      "a",
      await loadPastSessionsWithRetry("a", {
        attempts: 2,
        backoffMs: 1,
        fetchImpl: upFetch as unknown as typeof fetch,
        sleep: () => Promise.resolve(),
      }),
    );
    expect(upFetch).toHaveBeenCalledTimes(1);
    expect(store.sidebarSessionsError["a"]).toBe(false);
    expect(store.sidebarPastSessions["a"]).toEqual(sessions);
  });
});
