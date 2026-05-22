/**
 * Unit tests for the `awaitMutatorServer` helper. Each test pins the
 * exact resolved `MutatorOutcome` payload for one branch of the
 * discriminated union — see FRI-104 ACs #2.a–#2.g.
 */

import { describe, expect, it } from "vitest";

import { awaitMutatorServer, isPkCollision } from "./mutator-result";

describe("awaitMutatorServer", () => {
  it('awaitMutatorServer returns {kind:"success"} for {type:"success"}', async () => {
    const outcome = await awaitMutatorServer({
      server: Promise.resolve({ type: "success" }),
      client: Promise.resolve({ type: "success" }),
    });
    expect(outcome).toEqual({ kind: "success" });
  });

  it('awaitMutatorServer returns {kind:"app-error", pkCollision:true, message, details} for a blocks_pkey PG unique violation', async () => {
    const outcome = await awaitMutatorServer({
      server: Promise.resolve({
        type: "error",
        error: {
          type: "app",
          message:
            'duplicate key value violates unique constraint "blocks_pkey"',
          details: { name: "PostgresError" },
        },
      }),
      client: Promise.resolve({ type: "success" }),
    });
    expect(outcome).toEqual({
      kind: "app-error",
      message:
        'duplicate key value violates unique constraint "blocks_pkey"',
      details: { name: "PostgresError" },
      pkCollision: true,
    });
  });

  it('awaitMutatorServer returns {kind:"app-error", pkCollision:false} for an app error with no "duplicate key" substring', async () => {
    const outcome = await awaitMutatorServer({
      server: Promise.resolve({
        type: "error",
        error: {
          type: "app",
          message: "agent not found",
          details: undefined,
        },
      }),
      client: Promise.resolve({ type: "success" }),
    });
    expect(outcome).toEqual({
      kind: "app-error",
      message: "agent not found",
      details: undefined,
      pkCollision: false,
    });
  });

  it("awaitMutatorServer returns {kind:\"app-error\", pkCollision:false} for a non-blocks PK collision (ticket_pkey, etc.) so non-blocks unique violations don't false-positive as send-dedup", async () => {
    const outcome = await awaitMutatorServer({
      server: Promise.resolve({
        type: "error",
        error: {
          type: "app",
          message:
            'duplicate key value violates unique constraint "tickets_pkey"',
          details: { name: "PostgresError" },
        },
      }),
      client: Promise.resolve({ type: "success" }),
    });
    expect(outcome).toMatchObject({
      kind: "app-error",
      pkCollision: false,
    });
    // Belt-and-suspenders pin on the load-bearing classification field.
    if (typeof outcome === "object" && outcome.kind === "app-error") {
      expect(outcome.pkCollision).toBe(false);
    }
  });

  it('awaitMutatorServer returns {kind:"zero-error", message} for {type:"error", error:{type:"zero"}}', async () => {
    const outcome = await awaitMutatorServer({
      server: Promise.resolve({
        type: "error",
        error: { type: "zero", message: "Offline" },
      }),
      client: Promise.resolve({ type: "success" }),
    });
    expect(outcome).toEqual({ kind: "zero-error", message: "Offline" });
  });

  it('awaitMutatorServer returns "no-zero" for undefined input', async () => {
    const outcome = await awaitMutatorServer(undefined);
    expect(outcome).toBe("no-zero");
  });

  it('awaitMutatorServer backstops a rejecting server promise as {kind:"zero-error", message:"boom"} (defensive — Zero 1.5.0 contract says server never rejects, but if it ever does we must not throw)', async () => {
    // Pre-attach a no-op rejection handler so the deferred-rejection
    // detector in vitest doesn't flag the pending Promise.reject before
    // `awaitMutatorServer` awaits it.
    const serverPromise = Promise.reject(new Error("boom"));
    serverPromise.catch(() => {});
    const outcome = await awaitMutatorServer({
      server: serverPromise,
      client: Promise.resolve({ type: "success" }),
    });
    expect(outcome).toEqual({ kind: "zero-error", message: "boom" });
  });
});

describe("isPkCollision", () => {
  it("returns true only when BOTH the duplicate-key substring AND the blocks_pkey constraint name are present", () => {
    expect(
      isPkCollision(
        'duplicate key value violates unique constraint "blocks_pkey"',
        undefined,
      ),
    ).toBe(true);
  });

  it("returns false when the substring is present but the constraint name is not blocks_pkey", () => {
    expect(
      isPkCollision(
        'duplicate key value violates unique constraint "tickets_pkey"',
        undefined,
      ),
    ).toBe(false);
  });

  it("returns false when the constraint name appears without the duplicate-key substring", () => {
    expect(isPkCollision("blocks_pkey is broken somehow", undefined)).toBe(
      false,
    );
  });
});
