import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { daemonGet } from "$lib/server/daemon";
import type { Ticket } from "@friday/shared/services";

export interface TicketComment {
  id: number;
  author: string;
  body: string;
  ts: number;
}

export interface TicketExternalLink {
  system: string;
  externalId: string;
  url: string | null;
  meta?: Record<string, unknown> | null;
}

export type TicketDetail = Ticket & {
  externalLinks: TicketExternalLink[];
  comments: TicketComment[];
};

export const load: PageServerLoad = async ({ params, locals }) => {
  try {
    const ticket = await daemonGet<TicketDetail>(`/api/tickets/${params.id}`);
    // Surface a default author label for the comment input so the user
    // doesn't have to type their own name. Falls back to email if no
    // display name is set.
    const defaultAuthor = locals.user?.name || locals.user?.email || "user";
    return { ticket, defaultAuthor };
  } catch {
    throw error(404, "ticket not found");
  }
};
