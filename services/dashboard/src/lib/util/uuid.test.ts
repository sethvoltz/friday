import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "./uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUUID", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses crypto.randomUUID when present", () => {
    const spy = vi.fn(() => "11111111-1111-4111-8111-111111111111");
    vi.stubGlobal("crypto", { randomUUID: spy, getRandomValues: () => {} });
    expect(randomUUID()).toBe("11111111-1111-4111-8111-111111111111");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("falls back to a valid v4 UUID via getRandomValues on an insecure origin (no randomUUID)", () => {
    // Simulate Safari on http://192.168.x — getRandomValues exists,
    // randomUUID does not.
    vi.stubGlobal("crypto", {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = (i * 17 + 3) & 0xff;
        return arr;
      },
    });
    const id = randomUUID();
    expect(id).toMatch(V4);
    // Version nibble is 4 and variant nibble is one of 8/9/a/b.
    expect(id[14]).toBe("4");
    expect("89ab").toContain(id[19]);
  });

  it("falls back to Math.random when WebCrypto is entirely absent (never throws)", () => {
    vi.stubGlobal("crypto", undefined);
    const id = randomUUID();
    expect(id).toMatch(V4);
  });

  it("produces distinct ids across calls", () => {
    vi.unstubAllGlobals();
    const a = randomUUID();
    const b = randomUUID();
    expect(a).not.toBe(b);
    expect(a).toMatch(V4);
  });
});
