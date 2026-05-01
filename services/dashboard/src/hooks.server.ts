import type { Handle, HandleServerError } from "@sveltejs/kit";
import { logger } from "$lib/server/log";

logger.log("info", "dashboard_starting", {});

export const handle: Handle = async ({ event, resolve }) => {
  const start = Date.now();
  const response = await resolve(event);
  const durationMs = Date.now() - start;

  if (response.status >= 400) {
    logger.log(response.status >= 500 ? "error" : "warn", "request", {
      method: event.request.method,
      path: event.url.pathname,
      status: response.status,
      durationMs,
    });
  } else {
    logger.log("debug", "request", {
      method: event.request.method,
      path: event.url.pathname,
      status: response.status,
      durationMs,
    });
  }

  return response;
};

export const handleError: HandleServerError = ({ error, event }) => {
  logger.log("error", "unhandled_error", {
    method: event.request.method,
    path: event.url.pathname,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return {
    message: "Internal error",
  };
};
