CREATE TABLE "habit_checkins" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"habit_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "habits" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"mode" text NOT NULL,
	"target" integer DEFAULT 1 NOT NULL,
	"period" text NOT NULL,
	"days_of_week" integer,
	"bucket" text,
	"color_index" integer,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "habits_mode_check" CHECK ("habits"."mode" IN ('ongoing','bounded')),
	CONSTRAINT "habits_period_check" CHECK ("habits"."period" IN ('day','week','month','year')),
	CONSTRAINT "habits_bucket_check" CHECK ("habits"."bucket" IS NULL OR "habits"."bucket" IN ('morning','afternoon','evening','anytime')),
	CONSTRAINT "habits_color_index_check" CHECK ("habits"."color_index" IS NULL OR "habits"."color_index" BETWEEN 1 AND 7),
	CONSTRAINT "habits_status_check" CHECK ("habits"."status" IN ('active','archived','completed','expired')),
	CONSTRAINT "habits_days_of_week_period_check" CHECK ("habits"."days_of_week" IS NULL OR "habits"."period" = 'day')
);
--> statement-breakpoint
ALTER TABLE "habit_checkins" ADD CONSTRAINT "habit_checkins_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "habit_checkins_habit_ts" ON "habit_checkins" USING btree ("habit_id","ts");--> statement-breakpoint
CREATE INDEX "habits_status" ON "habits" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "habits_bucket" ON "habits" USING btree ("bucket");