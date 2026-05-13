import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// FIX_FORWARD 2.2: mail-as-block invariant. On every mail:any event, the
// bridge materializes a `role='user'`, `kind='text'`, `source='mail'` block
// in the recipient's session and surfaces the sender via content_json.

const dataDir = mkdtempSync(join(tmpdir(), "friday-mail-bridge-"));
process.env.FRIDAY_DATA_DIR = dataDir;

beforeAll(async () => {
  const { runMigrations } = await import("@friday/shared");
  runMigrations();
  const { startMailBridge } = await import("./mail-bridge.js");
  startMailBridge();
});

afterAll(async () => {
  const { closeDb } = await import("@friday/shared");
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { getRawDb } = await import("@friday/shared");
  getRawDb().prepare("DELETE FROM blocks").run();
});

describe("mail-bridge → mail-as-block (FIX_FORWARD 2.2)", () => {
  it("a fresh mailBus event lands a user-role source='mail' block", async () => {
    const { mailBus } = await import("@friday/shared/services");
    const { getRawDb } = await import("@friday/shared");

    mailBus.emit("mail:any", {
      id: 101,
      fromAgent: "alpha",
      toAgent: "unknown-recipient-1",
      type: "message",
      delivery: "pending",
      subject: null,
      threadId: null,
      body: "hello via mail",
      metaJson: null,
      ts: Date.now(),
      readAt: null,
      closedAt: null,
    });

    const rows = getRawDb()
      .prepare(
        "SELECT role, kind, source, agent_name, content_json FROM blocks WHERE agent_name = ?",
      )
      .all("unknown-recipient-1") as Array<{
        role: string;
        kind: string;
        source: string | null;
        agent_name: string;
        content_json: string;
      }>;
    expect(rows.length).toBe(1);
    expect(rows[0].role).toBe("user");
    expect(rows[0].kind).toBe("text");
    expect(rows[0].source).toBe("mail");

    const parsed = JSON.parse(rows[0].content_json) as {
      text: string;
      from_agent?: string;
    };
    expect(parsed.text).toBe("hello via mail");
    expect(parsed.from_agent).toBe("alpha");
  });

  it("multiple mail deliveries each get their own block keyed by mail id", async () => {
    const { mailBus } = await import("@friday/shared/services");
    const { getRawDb } = await import("@friday/shared");

    for (let i = 0; i < 3; i++) {
      mailBus.emit("mail:any", {
        id: 200 + i,
        fromAgent: "bravo",
        toAgent: "unknown-recipient-2",
        type: "message",
        delivery: "pending",
        subject: null,
        threadId: null,
        body: `body-${i}`,
        metaJson: null,
        ts: Date.now() + i,
        readAt: null,
        closedAt: null,
      });
    }

    const rows = getRawDb()
      .prepare(
        "SELECT turn_id FROM blocks WHERE agent_name = ? ORDER BY turn_id",
      )
      .all("unknown-recipient-2") as Array<{ turn_id: string }>;
    expect(rows.map((r) => r.turn_id)).toEqual([
      "mail_200",
      "mail_201",
      "mail_202",
    ]);
  });
});
