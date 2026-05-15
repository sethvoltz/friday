import {
  DraftingCompass,
  LifeBuoy,
  Hammer,
  CalendarClock,
  PawPrint,
} from "lucide-svelte";

export const AGENT_ICON: Record<string, typeof DraftingCompass> = {
  orchestrator: DraftingCompass,
  helper: LifeBuoy,
  builder: Hammer,
  scheduled: CalendarClock,
  bare: PawPrint,
};

export function agentIconFor(type: string): typeof DraftingCompass {
  return AGENT_ICON[type] ?? PawPrint;
}
