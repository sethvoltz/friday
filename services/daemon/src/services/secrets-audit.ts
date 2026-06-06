import { getDb, schema } from "@friday/shared";
import { and, eq, gte, sql } from "drizzle-orm";

const RATE_LIMIT_PER_HOUR = 10;

export async function logSecretsFetch(opts: {
  secretName: string;
  callerName: string;
  callerType: string;
  appId?: string | null;
  reason: string;
  source: "mcp" | "cli";
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getDb();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.secretsFetchLog)
    .where(
      and(
        eq(schema.secretsFetchLog.callerName, opts.callerName),
        gte(schema.secretsFetchLog.ts, oneHourAgo),
        eq(schema.secretsFetchLog.source, "mcp"),
      ),
    );
  const count = recent[0]?.count ?? 0;
  if (opts.source === "mcp" && count >= RATE_LIMIT_PER_HOUR) {
    return { ok: false, error: "rate limit exceeded (10 fetches/caller/hour)" };
  }

  await db.insert(schema.secretsFetchLog).values({
    secretName: opts.secretName,
    callerName: opts.callerName,
    callerType: opts.callerType,
    appId: opts.appId ?? null,
    reason: opts.reason.slice(0, 512),
    source: opts.source,
  });
  return { ok: true };
}
