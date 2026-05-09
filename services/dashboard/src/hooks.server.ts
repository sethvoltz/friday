import { redirect, type Handle } from "@sveltejs/kit";
import { auth } from "$lib/server/auth";
import { logger } from "$lib/server/log";

const PUBLIC_PATHS = new Set(["/login", "/api/auth"]);

export const handle: Handle = async ({ event, resolve }) => {
  const start = Date.now();

  // BetterAuth route handler — handles /api/auth/* itself
  if (event.url.pathname.startsWith("/api/auth")) {
    return auth.handler(event.request);
  }

  // Resolve session
  let session: Awaited<ReturnType<typeof auth.api.getSession>> | null = null;
  try {
    session = await auth.api.getSession({ headers: event.request.headers });
  } catch (err) {
    logger.log("warn", "auth.session.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  event.locals.user = session?.user
    ? { id: session.user.id, email: session.user.email, name: session.user.name }
    : null;
  event.locals.session = session?.session
    ? {
        id: session.session.id,
        userId: session.session.userId,
        expiresAt: new Date(session.session.expiresAt),
      }
    : null;

  // Auth gate
  const isPublic = [...PUBLIC_PATHS].some((p) => event.url.pathname.startsWith(p));
  if (!event.locals.user && !isPublic) {
    throw redirect(302, "/login");
  }

  const response = await resolve(event);
  const durationMs = Date.now() - start;
  logger.log(response.status >= 500 ? "error" : "info", "request", {
    method: event.request.method,
    path: event.url.pathname,
    status: response.status,
    durationMs,
    userId: event.locals.user?.id,
  });
  return response;
};
