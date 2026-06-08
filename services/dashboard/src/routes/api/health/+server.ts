import { type RequestHandler } from "@sveltejs/kit";
import { PUBLIC_APP_VERSION } from "$env/static/public";

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  return new Response(null, {
    status: 200,
    headers: { "X-Friday-Version": PUBLIC_APP_VERSION },
  });
};

export const HEAD: RequestHandler = GET;
