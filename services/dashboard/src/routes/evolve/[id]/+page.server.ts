import { getProposal, applyProposal, rejectProposal, type Proposal } from "@friday/evolve";
import { error, fail } from "@sveltejs/kit";
import type { Actions } from "./$types.js";

export function load({ params }: { params: { id: string } }): { proposal: Proposal } {
  const proposal = getProposal(params.id);
  if (!proposal) throw error(404, "Proposal not found");
  return { proposal };
}

export const actions: Actions = {
  approve: async ({ params }) => {
    const outcome = applyProposal(params.id!, { appliedBy: "dashboard" });
    if (!outcome.ok) {
      return fail(400, { ok: false, message: outcome.reason });
    }
    return {
      ok: true,
      message: `Applied — ${outcome.appliedRef}`,
      restartHint: outcome.restartHint ?? null,
    };
  },

  reject: async ({ params, request }) => {
    const formData = await request.formData();
    const reason = String(formData.get("reason") ?? "").trim() || undefined;
    const proposal = rejectProposal(params.id!, { rejectedBy: "dashboard", reason });
    if (!proposal) return fail(404, { ok: false, message: "proposal not found" });
    return { ok: true, message: "Rejected." };
  },
};
