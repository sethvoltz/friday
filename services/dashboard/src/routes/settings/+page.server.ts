import { redirect, type ServerLoad } from "@sveltejs/kit";

export const load: ServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/login");
  return { user: locals.user };
};
