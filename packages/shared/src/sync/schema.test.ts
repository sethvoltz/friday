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
import { permissions, schema } from "./schema.js";
import { SYNC_TABLES } from "../db/pg-provision.js";

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

describe("ADR-024 Zero sync schema — schedule_runs slice", () => {
  // The schedule_runs table is declared in db/schema.ts and published for
  // replication (pg-provision SYNC_TABLES), but was missing from the Zero
  // client schema — so its rows never reached the dashboard. Pin the projected
  // columns + nullability so a regression dropping or mistyping one is caught.
  const columns = schema.tables.schedule_runs.columns as Record<
    string,
    { type: string; optional: boolean }
  >;

  it("is registered as a synced table with id as the primary key", () => {
    expect(schema.tables.schedule_runs).toBeDefined();
    expect(columns.id).toMatchObject({ type: "number", optional: false });
  });

  it("projects schedule_name / fired_at / status as non-optional", () => {
    expect(columns.schedule_name).toMatchObject({ type: "string", optional: false });
    expect(columns.fired_at).toMatchObject({ type: "number", optional: false });
    expect(columns.status).toMatchObject({ type: "string", optional: false });
  });

  it("projects completed_at / error as optional (NULL while a run is 'running')", () => {
    expect(columns.completed_at).toMatchObject({ type: "number", optional: true });
    expect(columns.error).toMatchObject({ type: "string", optional: true });
  });

  it("grants select on schedule_runs (read-only history; no client mutator)", async () => {
    const resolved = await permissions;
    expect(resolved?.tables?.schedule_runs).toBeDefined();
  });
});

describe("FRI-171 (ADR-047) Zero sync schema — inbox_items slice", () => {
  // `inbox_items` must appear in BOTH SYNC_TABLES (logical-replication
  // publication) AND the Zero client schema (createSchema tables array +
  // definePermissions). Missing either reintroduces the SchemaVersionNotSupported
  // reload loop (CLAUDE.md upgrade gotcha #2). `apikey` is deliberately NOT
  // replicated (server-only, like `user`/`session`).
  const columns = schema.tables.inbox_items.columns as Record<
    string,
    { type: string; optional: boolean }
  >;

  it("is in SYNC_TABLES AND NOT apikey", () => {
    expect(SYNC_TABLES).toContain("inbox_items");
    expect(SYNC_TABLES).not.toContain("apikey");
  });

  it("is registered as a synced table with id as the primary key", () => {
    expect(schema.tables.inbox_items).toBeDefined();
    expect(columns.id).toMatchObject({ type: "string", optional: false });
  });

  it("projects the NOT-NULL columns as non-optional", () => {
    expect(columns.created_at).toMatchObject({ type: "number", optional: false });
    expect(columns.source).toMatchObject({ type: "string", optional: false });
    expect(columns.raw_text).toMatchObject({ type: "string", optional: false });
    expect(columns.kind).toMatchObject({ type: "string", optional: false });
    expect(columns.state).toMatchObject({ type: "string", optional: false });
    expect(columns.undoable).toMatchObject({ type: "boolean", optional: false });
  });

  it("projects the nullable columns as optional", () => {
    expect(columns.cleaned_text).toMatchObject({ type: "string", optional: true });
    expect(columns.target_id).toMatchObject({ type: "string", optional: true });
    expect(columns.payload).toMatchObject({ type: "json", optional: true });
    expect(columns.rationale).toMatchObject({ type: "string", optional: true });
    expect(columns.resolved_at).toMatchObject({ type: "number", optional: true });
    expect(columns.inverse_label).toMatchObject({ type: "string", optional: true });
    expect(columns.deep_link).toMatchObject({ type: "string", optional: true });
  });

  it("grants select on inbox_items so the bell + Inbox review can read rows", async () => {
    const resolved = await permissions;
    expect(resolved?.tables?.inbox_items).toBeDefined();
  });
});
