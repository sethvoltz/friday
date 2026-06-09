import {
  DraftingCompass,
  LifeBuoy,
  Hammer,
  CalendarClock,
  PawPrint,
  ClipboardList,
} from "lucide-svelte";

export const AGENT_ICON: Record<string, typeof DraftingCompass> = {
  orchestrator: DraftingCompass,
  helper: LifeBuoy,
  builder: Hammer,
  scheduled: CalendarClock,
  bare: PawPrint,
  planner: ClipboardList,
};

export function agentIconFor(type: string): typeof DraftingCompass {
  return AGENT_ICON[type] ?? PawPrint;
}
