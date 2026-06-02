/**
 * FRI-143 (AC8) — the Zero sync `schedules` slice must project the new
 * `kind` and `delivery_json` columns so the dashboard's reactive query can
 * distinguish a reminder row from an agent-run row and render its delivery
 * payload. A missing column here means the dashboard never sees the field
 * even though Postgres replicates it.
 *
 * Asserts against the runtime column descriptors produced by
 * `@rocicorp/zero`'s `createSchema` (table.columns is a record of
 * column-name → { type, optional, ... }). Pins the exact projected type and
 * nullability so a regression that drops the column, mistypes it, or flips
 * its nullability is caught.
 */

import { describe, expect, it } from "vitest";
import { schema } from "./schema.js";

describe("FRI-143 Zero sync schema — schedules slice (AC8)", () => {
  const columns = schema.tables.schedules.columns as Record<
    string,
    { type: string; optional: boolean }
  >;

  it("projects `kind` as a non-optional string (DB column is NOT NULL with a default)", () => {
    expect(columns.kind).toMatchObject({ type: "string", optional: false });
  });

  it("projects `delivery_json` as an optional json column (nullable jsonb)", () => {
    expect(columns.delivery_json).toMatchObject({ type: "json", optional: true });
  });

  it("exposes both new columns alongside the existing schedules columns", () => {
    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining(["kind", "delivery_json", "name", "task_prompt", "status"]),
    );
  });
});
