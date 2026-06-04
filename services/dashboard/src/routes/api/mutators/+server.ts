/**
 * Phase 4 (ADR-023): Zero custom-mutator server-side dispatch.
 *
 * Zero's mutator framework runs each mutation twice: once on the client
 * (optimistic, local-store-only) and once on the server (canonical,
 * against Postgres). zero-cache forwards the server-side run to this
 * endpoint over HTTP — the URL is configured via `ZERO_MUTATE_URL` in
 * `~/.friday/.env` (provisioned by `friday setup`).
 *
 * Request shape: zero-cache POSTs a batched envelope containing one or
 * more mutations with their args + a `mutation_id`. `PushProcessor`
 * unpacks the envelope, looks up each mutator by name in the
 * `createMutators()` map (the SAME map the client passes to
 * `new Zero({ mutators, ... })`, so client + server execute identical
 * logic), and runs it inside a single Postgres transaction per
 * mutation.
 *
 * Auth: this endpoint is reachable only by zero-cache running on
 * `127.0.0.1:4848`. The dashboard's reverse-proxy invariant (CFT only
 * exposes the dashboard's public port) keeps it off the public net.
 * Per-user authorization rides on the JWT zero-cache passes through
 * (verified by zero-cache before forwarding); the mutator body can
 * trust `request.userID` to identify the BetterAuth user.
 *
 * Idempotency: PushProcessor handles `mutation_id` dedup (a retried
 * request runs the mutator zero or one times at the server). Friday's
 * mutators additionally enforce row-PK idempotency per plan §5
 * (e.g., `markRead` UPSERTs on (device_id, agent_name) so a duplicate
 * with the same args is a no-op).
 */

import type { RequestHandler } from "@sveltejs/kit";
import { PushProcessor } from "@rocicorp/zero/server";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { createMutators, schema } from "@friday/shared/sync";
import { verifyZeroJwt } from "@friday/shared/sync/jwt";
import { getPool, loadFridayConfig } from "@friday/shared";

// Memoize the PushProcessor instance across requests. It holds a
// reference to the pg Pool (via ZQLDatabase); constructing one per
// request would leak transaction client-lease overhead.
let processor: PushProcessor<
  typeof schema,
  ReturnType<typeof zeroNodePg<typeof schema>>,
  ReturnType<typeof createMutators>
> | null = null;

function getProcessor(): NonNullable<typeof processor> {
  if (processor) return processor;
  const pool = getPool();
  const zql = zeroNodePg(schema, pool);
  processor = new PushProcessor(zql);
  return processor;
}

/**
 * The verified BetterAuth user behind this push. zero-cache verifies the
 * client's JWT before forwarding the run here and passes it through as the
 * `Authorization: Bearer <jwt>` header; we re-verify it with the same
 * `ZERO_AUTH_SECRET` (cheap HS256 check, and `/api/mutators` is loopback-only
 * so only zero-cache can reach it) and read `userId`. This is the trusted
 * identity `sendUserMessage` stamps onto `blocks.user_id` — so the daemon,
 * which only sees the canonical Postgres row, can attribute the turn's
 * PostHog events to the originating user. Header absent/invalid → null →
 * no author recorded (the event attributes to the `friday-daemon` service
 * actor downstream). Only headers are read, so `process()` still gets the
 * request body intact.
 */
function verifiedUserId(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
  const secret = loadFridayConfig().zeroAuthSecret;
  if (!secret) return null;
  const claims = verifyZeroJwt(token, secret, Math.floor(Date.now() / 1000));
  return claims?.userId ?? null;
}

export const POST: RequestHandler = async ({ request }) => {
  const userId = verifiedUserId(request);
  const result = await getProcessor().process(createMutators(userId), request);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
