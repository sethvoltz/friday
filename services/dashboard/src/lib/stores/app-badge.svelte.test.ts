/**
 * FRI-142 (ADR-048) — the home-screen app-icon badge driver (open-app case).
 *
 * Mocks the Badging API boundary (`navigator.setAppBadge` / `clearAppBadge`)
 * and asserts the exact calls: positive count ⇒ `setAppBadge(n)`, zero ⇒
 * `clearAppBadge()`, redundant value ⇒ no call (dedup), and a missing API ⇒
 * silent no-op. Pins the integer the OS receives, since that's what the daemon
 * push-stamped count must agree with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppBadgeCount, __resetAppBadgeForTest } from "./app-badge.svelte";

const setAppBadge = vi.fn(() => Promise.resolve());
const clearAppBadge = vi.fn(() => Promise.resolve());

beforeEach(() => {
  __resetAppBadgeForTest();
  setAppBadge.mockClear();
  clearAppBadge.mockClear();
  vi.stubGlobal("navigator", { setAppBadge, clearAppBadge });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("setAppBadgeCount — Badging API calls", () => {
  it("sets the exact integer for a positive count", () => {
    setAppBadgeCount(3);
    expect(setAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).toHaveBeenCalledWith(3);
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it("clears the badge at zero", () => {
    setAppBadgeCount(2); // prime to a non-zero value
    setAppBadge.mockClear();
    setAppBadgeCount(0);
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it("floors a fractional count and treats negatives as zero", () => {
    setAppBadgeCount(2.9);
    expect(setAppBadge).toHaveBeenCalledWith(2);
    __resetAppBadgeForTest();
    setAppBadge.mockClear();
    clearAppBadge.mockClear();
    setAppBadgeCount(-5);
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it("dedups — the same count twice calls the API only once", () => {
    setAppBadgeCount(4);
    setAppBadgeCount(4);
    expect(setAppBadge).toHaveBeenCalledTimes(1);
  });

  it("a new distinct value re-fires", () => {
    setAppBadgeCount(1);
    setAppBadgeCount(5);
    expect(setAppBadge).toHaveBeenCalledTimes(2);
    expect(setAppBadge).toHaveBeenLastCalledWith(5);
  });
});

describe("setAppBadgeCount — unsupported platform", () => {
  it("is a silent no-op when the Badging API is absent (plain tab)", () => {
    __resetAppBadgeForTest();
    vi.stubGlobal("navigator", {}); // no setAppBadge
    expect(() => setAppBadgeCount(7)).not.toThrow();
    // Restore the spied navigator and confirm NO call leaked through.
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();
  });
});
