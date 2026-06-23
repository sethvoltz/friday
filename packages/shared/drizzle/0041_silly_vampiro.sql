CREATE TABLE "web_push_vapid" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "web_push_vapid_singleton_check" CHECK ("web_push_vapid"."id" = 'singleton')
);
