import { json, type RequestHandler } from "@sveltejs/kit";
import { existsSync, readFileSync } from "node:fs";
import { getLogPath } from "@friday/shared";

export const GET: RequestHandler = async ({ params, url, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const svc = params.service;
  if (svc !== "daemon" && svc !== "dashboard") {
    return new Response("invalid service", { status: 400 });
  }
  const n = Math.min(Number(url.searchParams.get("n") ?? 200), 2000);
  const path = getLogPath(svc);
  if (!existsSync(path)) return json([]);
  const raw = readFileSync(path, "utf8");
  const lines = raw.trimEnd().split("\n").slice(-n);
  return json(lines);
};
