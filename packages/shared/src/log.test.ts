import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "./log.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "friday-log-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for condition");
}

describe("createLogger rotation", () => {
  it("unlinks the rotated .jsonl after gzip completes", async () => {
    const logPath = join(dir, "svc.jsonl");
    const logger = createLogger({
      service: "svc",
      stdoutMode: "off",
      logPath,
      rotateBytes: 512,
    });

    // Each line is ~80 bytes; 20 lines easily crosses the 512-byte threshold
    // and triggers a rotation.
    for (let i = 0; i < 20; i++) {
      logger.log("info", "tick", { i, pad: "x".repeat(50) });
    }
    logger.close();

    await waitFor(() => {
      const files = readdirSync(dir);
      const hasGz = files.some((f) => f.endsWith(".jsonl.gz"));
      const rotatedJsonl = files.filter(
        (f) => f !== "svc.jsonl" && f.endsWith(".jsonl"),
      );
      return hasGz && rotatedJsonl.length === 0;
    });

    const files = readdirSync(dir);
    expect(files.some((f) => f.endsWith(".jsonl.gz"))).toBe(true);
    expect(
      files.filter((f) => f !== "svc.jsonl" && f.endsWith(".jsonl")),
    ).toEqual([]);
    expect(files).toContain("svc.jsonl");
  });
});
