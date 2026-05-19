import { json, type RequestHandler } from "@sveltejs/kit";
import { existsSync, readFileSync } from "node:fs";
import { getLogPath, SERVICES, type ServiceName } from "@friday/shared";

export const GET: RequestHandler = async ({ params, url, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const svc = params.service;
  if (!svc || !(SERVICES as readonly string[]).includes(svc)) {
    return new Response("invalid service", { status: 400 });
  }
  const n = Math.min(Number(url.searchParams.get("n") ?? 200), 2000);
  const path = getLogPath(svc as ServiceName);
  if (!existsSync(path)) return json([]);
  const raw = readFileSync(path, "utf8");
  const lines = raw.trimEnd().split("\n").slice(-n);
  return json(lines);
};
