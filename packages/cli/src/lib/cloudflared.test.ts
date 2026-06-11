import { describe, expect, it } from "vitest";
import { decideTunnelAction, sha256, type TunnelDecisionInput } from "./cloudflared.js";

/**
 * The reconcile decision (FRI-166) is the bug-prone core: it decides whether
 * the cloudflared launch agent gets installed, reinstalled, torn down, or left
 * alone, purely from (serve-intent, token, installed-state, fingerprints). The
 * effectful wrapper is a thin switch over `spawnSync`; the truth table is here.
 */

const SHA_A = sha256("token-a");
const SHA_B = sha256("token-b");

/** Build a decision input with sensible defaults; override per case. */
function input(overrides: Partial<TunnelDecisionInput>): TunnelDecisionInput {
  return {
    serve: false,
    hasToken: false,
    installed: false,
    installedSha: null,
    tokenSha: null,
    ...overrides,
  };
}

describe("decideTunnelAction", () => {
  it("install: serve-intent on + token present + agent not yet installed → install (DR / first setup)", () => {
    expect(
      decideTunnelAction(input({ serve: true, hasToken: true, installed: false, tokenSha: SHA_A })),
    ).toBe("install");
  });

  it("noop: serve-intent on + token + already installed with the SAME token → noop (idempotent, no bounce)", () => {
    expect(
      decideTunnelAction(
        input({
          serve: true,
          hasToken: true,
          installed: true,
          installedSha: SHA_A,
          tokenSha: SHA_A,
        }),
      ),
    ).toBe("noop");
  });

  it("reinstall: serve-intent on + token + installed with a DIFFERENT token → reinstall (rotation)", () => {
    expect(
      decideTunnelAction(
        input({
          serve: true,
          hasToken: true,
          installed: true,
          installedSha: SHA_A,
          tokenSha: SHA_B,
        }),
      ),
    ).toBe("reinstall");
  });

  it("noop: serve-intent on + token + installed but installed fingerprint UNKNOWN → noop (don't bounce on a hunch)", () => {
    // Pre-FRI-166 agent: no state file, installedSha null. We leave the running
    // tunnel alone rather than gratuitously reinstall it.
    expect(
      decideTunnelAction(
        input({
          serve: true,
          hasToken: true,
          installed: true,
          installedSha: null,
          tokenSha: SHA_A,
        }),
      ),
    ).toBe("noop");
  });

  it("uninstall: serve-intent OFF but agent installed → uninstall (removed serve-intent tears it down)", () => {
    expect(
      decideTunnelAction(input({ serve: false, hasToken: true, installed: true, tokenSha: SHA_A })),
    ).toBe("uninstall");
  });

  it("noop: serve-intent off + not installed → noop (fresh/staged box stays dark)", () => {
    expect(
      decideTunnelAction(
        input({ serve: false, hasToken: true, installed: false, tokenSha: SHA_A }),
      ),
    ).toBe("noop");
  });

  it("uninstall: token removed (serve still on) + agent installed → uninstall (rotate-away tears it down)", () => {
    expect(decideTunnelAction(input({ serve: true, hasToken: false, installed: true }))).toBe(
      "uninstall",
    );
  });

  it("noop: token removed + not installed → noop", () => {
    expect(decideTunnelAction(input({ serve: true, hasToken: false, installed: false }))).toBe(
      "noop",
    );
  });

  // The load-bearing split-brain invariant (FRI-166): with serve-intent OFF,
  // the decision is NEVER install/reinstall — a staged/restored box can't be
  // brought live by reconcile no matter what token or state it carries.
  it("split-brain guard: serve-intent off never yields install/reinstall across the full state space", () => {
    const bools = [false, true];
    const shas = [null, SHA_A, SHA_B];
    for (const hasToken of bools) {
      for (const installed of bools) {
        for (const installedSha of shas) {
          for (const tokenSha of shas) {
            const action = decideTunnelAction(
              input({ serve: false, hasToken, installed, installedSha, tokenSha }),
            );
            expect(action).not.toBe("install");
            expect(action).not.toBe("reinstall");
            // It can only ever be uninstall (if installed) or noop.
            expect(action).toBe(installed ? "uninstall" : "noop");
          }
        }
      }
    }
  });
});

describe("sha256", () => {
  it("is deterministic and 64 lowercase hex chars", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
    expect(sha256("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes different tokens (so rotation is detectable)", () => {
    expect(sha256("token-a")).not.toBe(sha256("token-b"));
  });
});
