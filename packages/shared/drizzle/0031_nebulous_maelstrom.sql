ALTER TABLE "agents" DROP CONSTRAINT "agents_type_check";--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "models" jsonb;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "evolve_models" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_type_check" CHECK ("agents"."type" IN ('orchestrator','builder','helper','scheduled','bare','planner'));