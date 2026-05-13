import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let raw: Database.Database;

vi.mock("../db/client.js", async () => {
  const drizzleMod = await import("drizzle-orm/better-sqlite3");
  const schema = await import("../db/schema.js");
  return {
    getRawDb: () => raw,
    getDb: () => drizzleMod.drizzle(raw, { schema }),
    closeDb: () => raw.close(),
  };
});

beforeEach(async () => {
  raw = new Database(":memory:");
  raw.pragma("journal_mode = MEMORY");
  raw.pragma("foreign_keys = ON");
  const { runMigrations } = await import("../db/migrate.js");
  runMigrations();
});

afterEach(() => {
  raw.close();
});

describe("rate-limit (FIX_FORWARD 5.7)", () => {
  it("allows up to `max` consumes within the window", async () => {
    const { consumeRateLimit } = await import("./rate-limit.js");
    for (let i = 0; i < 5; i++) {
      const r = consumeRateLimit({
        key: "auth:1.2.3.4",
        windowMs: 60_000,
        max: 5,
      });
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(4 - i);
    }
  });

  it("triggers a lockout on the 6th attempt with lockoutMs", async () => {
    const { consumeRateLimit } = await import("./rate-limit.js");
    for (let i = 0; i < 5; i++) {
      consumeRateLimit({
        key: "auth:1.2.3.4",
        windowMs: 15 * 60_000,
        max: 5,
        lockoutMs: 30 * 60_000,
      });
    }
    const blocked = consumeRateLimit({
      key: "auth:1.2.3.4",
      windowMs: 15 * 60_000,
      max: 5,
      lockoutMs: 30 * 60_000,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs ?? 0).toBeGreaterThan(29 * 60_000);
  });

  it("isolates buckets by key", async () => {
    const { consumeRateLimit } = await import("./rate-limit.js");
    for (let i = 0; i < 5; i++) {
      consumeRateLimit({ key: "auth:1.2.3.4", windowMs: 60_000, max: 5 });
    }
    const other = consumeRateLimit({
      key: "auth:5.6.7.8",
      windowMs: 60_000,
      max: 5,
    });
    expect(other.allowed).toBe(true);
  });

  it("resetRateLimit clears one key", async () => {
    const { consumeRateLimit, resetRateLimit } = await import("./rate-limit.js");
    for (let i = 0; i < 5; i++) {
      consumeRateLimit({ key: "auth:1.2.3.4", windowMs: 60_000, max: 5 });
    }
    resetRateLimit("auth:1.2.3.4");
    const r = consumeRateLimit({
      key: "auth:1.2.3.4",
      windowMs: 60_000,
      max: 5,
    });
    expect(r.allowed).toBe(true);
  });

  it("resetRateLimitPrefix wipes every matching bucket", async () => {
    const { consumeRateLimit, resetRateLimitPrefix } = await import(
      "./rate-limit.js"
    );
    for (let i = 0; i < 5; i++) {
      consumeRateLimit({
        key: "auth:1.2.3.4",
        windowMs: 60_000,
        max: 5,
        lockoutMs: 1_000_000,
      });
    }
    consumeRateLimit({
      key: "auth:1.2.3.4",
      windowMs: 60_000,
      max: 5,
      lockoutMs: 1_000_000,
    });
    consumeRateLimit({ key: "mail:alpha", windowMs: 60_000, max: 5 });

    const cleared = resetRateLimitPrefix("auth:");
    expect(cleared).toBeGreaterThanOrEqual(1);
    const reopened = consumeRateLimit({
      key: "auth:1.2.3.4",
      windowMs: 60_000,
      max: 5,
    });
    expect(reopened.allowed).toBe(true);
    // mail bucket survived.
    const mailStill = consumeRateLimit({
      key: "mail:alpha",
      windowMs: 60_000,
      max: 5,
    });
    expect(mailStill.allowed).toBe(true);
    expect(mailStill.remaining).toBe(3);
  });

  it("state persists across the helper boundary (db-backed)", async () => {
    const { consumeRateLimit } = await import("./rate-limit.js");
    consumeRateLimit({ key: "mail:alpha", windowMs: 60_000, max: 3 });
    consumeRateLimit({ key: "mail:alpha", windowMs: 60_000, max: 3 });
    const third = consumeRateLimit({
      key: "mail:alpha",
      windowMs: 60_000,
      max: 3,
    });
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    const fourth = consumeRateLimit({
      key: "mail:alpha",
      windowMs: 60_000,
      max: 3,
    });
    expect(fourth.allowed).toBe(false);
  });
});
