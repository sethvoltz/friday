/**
 * FRI-142 / ADR-048 (Layer 3) — Producer-agnostic Route-target registry.
 *
 * The falsification gate for AC8's resolver half: a FABRICATED, NON-Intake
 * target — registered with an id that is NOT in Intake's `RouteTargetId`
 * taxonomy (e.g. `system:cert_renew`) — must resolve + execute through the SAME
 * registry. Before the Layer-3 lift, `approveInbox` resolved via the
 * Intake-bound `assembleRegistry().find(...)` and threw "route target … is no
 * longer available" on any non-Intake id. This pins that a non-Intake producer
 * is now first-class.
 *
 * The `intake/inbox-non-intake-target.test.ts` companion drives the SAME
 * fabricated target end-to-end through `approveInbox`/`undoInbox`; this file
 * pins the registry primitive in isolation (static targets, dynamic providers,
 * static-wins-on-collision, undo dispatch).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerTarget,
  registerTargets,
  registerTargetProvider,
  resolveTarget,
  assembleAllTargets,
  __resetRouteRegistryForTest,
  type RouteTarget,
  type ResultReference,
} from "./route-registry.js";

/** A trivially-valid payload schema (everything passes). */
const anySchema = { safeParse: (data: unknown) => ({ success: true as const, data }) };

function fabricatedTarget(over: Partial<RouteTarget> = {}): RouteTarget {
  return {
    id: "system:cert_renew",
    guidance: "renew an expiring TLS certificate",
    payloadSchema: anySchema,
    execute: vi.fn(
      async (): Promise<ResultReference> => ({
        undoable: true,
        inverseLabel: "Roll back the cert",
        deepLink: "/system/certs?undo=cert-1",
      }),
    ),
    undo: vi.fn(async () => true),
    ...over,
  };
}

beforeEach(() => __resetRouteRegistryForTest());
afterEach(() => {
  __resetRouteRegistryForTest();
  vi.clearAllMocks();
});

describe("resolveTarget — a fabricated NON-Intake target resolves (AC8)", () => {
  it("resolves a statically-registered non-Intake id and runs its executor", async () => {
    const target = fabricatedTarget();
    registerTarget(target);

    const resolved = await resolveTarget("system:cert_renew");
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe("system:cert_renew");

    const ref = await resolved!.execute({ domain: "example.com" });
    expect(target.execute).toHaveBeenCalledWith({ domain: "example.com" });
    expect(ref).toEqual({
      undoable: true,
      inverseLabel: "Roll back the cert",
      deepLink: "/system/certs?undo=cert-1",
    });
  });

  it("the resolved target's OWN undo reverses it (no Intake-keyed switch)", async () => {
    const target = fabricatedTarget();
    registerTarget(target);
    const resolved = await resolveTarget("system:cert_renew");
    const removed = await resolved!.undo!("/system/certs?undo=cert-1");
    expect(removed).toBe(true);
    expect(target.undo).toHaveBeenCalledWith("/system/certs?undo=cert-1");
  });

  it("returns null for an unregistered id (callers turn this into 'no longer available')", async () => {
    expect(await resolveTarget("system:nothing")).toBeNull();
  });
});

describe("resolveTarget — dynamic providers (Intake's app/orchestrator set)", () => {
  it("resolves a target produced by a dynamic provider, re-evaluated at resolve time", async () => {
    let agentName = "kitchen";
    const provider = vi.fn(
      async (): Promise<RouteTarget[]> => [
        {
          id: `agent:${agentName}`,
          guidance: "mail the app agent",
          payloadSchema: anySchema,
          execute: async () => ({ undoable: false, deepLink: "/mail?id=1" }),
        },
      ],
    );
    registerTargetProvider(provider);

    expect(await resolveTarget("agent:kitchen")).not.toBeNull();
    expect(await resolveTarget("agent:garage")).toBeNull();

    // The provider is re-evaluated each resolve — a runtime change is reflected.
    agentName = "garage";
    expect(await resolveTarget("agent:garage")).not.toBeNull();
  });

  it("checks the static Map BEFORE evaluating providers (provider not called for a static hit)", async () => {
    const provider = vi.fn(async (): Promise<RouteTarget[]> => []);
    registerTarget(fabricatedTarget());
    registerTargetProvider(provider);

    await resolveTarget("system:cert_renew");
    // Static hit short-circuits — the provider is never evaluated.
    expect(provider).not.toHaveBeenCalled();
  });
});

describe("assembleAllTargets — merge + de-dup", () => {
  it("returns static targets plus every provider's current output, de-duped by id", async () => {
    registerTargets([fabricatedTarget({ id: "system:a" }), fabricatedTarget({ id: "system:b" })]);
    registerTargetProvider(async () => [fabricatedTarget({ id: "agent:k" })]);

    const all = await assembleAllTargets();
    expect(all.map((t) => t.id).sort()).toEqual(["agent:k", "system:a", "system:b"]);
  });

  it("a static target WINS over a provider target with the same id (provider can't shadow core)", async () => {
    const coreExecute = vi.fn(async () => ({ undoable: true, deepLink: "/core" }));
    registerTarget(fabricatedTarget({ id: "core:reminder", execute: coreExecute }));
    registerTargetProvider(async () => [
      fabricatedTarget({
        id: "core:reminder",
        execute: vi.fn(async () => ({ undoable: false, deepLink: "/shadow" })),
      }),
    ]);

    const all = await assembleAllTargets();
    const reminder = all.filter((t) => t.id === "core:reminder");
    expect(reminder).toHaveLength(1);
    const ref = await reminder[0]!.execute({});
    expect(ref.deepLink).toBe("/core"); // the static one won
  });
});
