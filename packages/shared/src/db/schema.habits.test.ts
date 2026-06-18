// FRI-169 AC1 — habits / habit_checkins column-shape test.
//
// Pins the exact column set of both habit tables. The acceptance
// criterion (AC1) names the columns explicitly; this test imports the
// pgTable declarations and asserts `getTableColumns(...)` keys deep-equal
// that list, so a renamed/dropped/added column fails here rather than
// surfacing as a Zero-mirror drift or a migration surprise.
//
// Pure import-and-introspect: no DB connection (the constraint behavior —
// color_index range, days_of_week×period orthogonality — is exercised in
// schema.habits.pg.test.ts against a scratch Postgres).

import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { habitCheckins, habits } from "./schema.js";

describe("FRI-169 schema: habits", () => {
  it("habits exposes exactly the AC1 column set", () => {
    // AC1: id, name, description, mode, target, days_of_week, period,
    // bucket, color_index, window_start, window_end, status, created_at,
    // updated_at. Assert on the *physical* (snake_case) column names so a
    // mismatch with the Zero mirror / migration is caught.
    const cols = Object.values(getTableColumns(habits))
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(
      [
        "bucket",
        "color_index",
        "created_at",
        "days_of_week",
        "description",
        "id",
        "mode",
        "name",
        "period",
        "status",
        "target",
        "updated_at",
        "window_end",
        "window_start",
      ].sort(),
    );
  });

  it("habits.id is the text-uuid primary key (not bigserial)", () => {
    // Load-bearing per §3/§9 default (b): the client-supplied-PK
    // convention is what lets a habit-CRUD mutator (future) target the
    // canonical row. A bigserial here would silently break that.
    const id = getTableColumns(habits).id;
    expect(id.primary).toBe(true);
    expect(id.columnType).toBe("PgText");
    expect(id.hasDefault).toBe(true);
  });

  it("habit_checkins exposes exactly the AC1 column set", () => {
    const cols = Object.values(getTableColumns(habitCheckins))
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(["id", "habit_id", "ts", "note", "created_at"].sort());
  });

  it("habit_checkins.id is the text-uuid primary key (client supplies it at INSERT)", () => {
    const id = getTableColumns(habitCheckins).id;
    expect(id.primary).toBe(true);
    expect(id.columnType).toBe("PgText");
    expect(id.hasDefault).toBe(true);
  });

  it("habit_checkins.created_at carries a now() default so the optimistic mutator INSERT lands", () => {
    // The `habitCheckin` mutator writes only id/habit_id/ts/note; the
    // NOT NULL created_at must be server-defaulted or the canonical INSERT
    // would violate the constraint.
    // getTableColumns keys are the Drizzle JS property names (camelCase);
    // the physical column name lives on `.name` (asserted above).
    const createdAt = getTableColumns(habitCheckins).createdAt;
    expect(createdAt.name).toBe("created_at");
    expect(createdAt.notNull).toBe(true);
    expect(createdAt.hasDefault).toBe(true);
  });
});
