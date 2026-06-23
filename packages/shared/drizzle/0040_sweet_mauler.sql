CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
ALTER TABLE "inbox_items" ALTER COLUMN "raw_text" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "notify_policy" jsonb;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "dnd_start" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "dnd_end" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "critical_bypass_dnd" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_device_id_client_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."client_devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_subscriptions_device" ON "push_subscriptions" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user" ON "push_subscriptions" USING btree ("user_id");