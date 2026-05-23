ALTER TABLE "mail" DROP CONSTRAINT "mail_delivery_check";--> statement-breakpoint
ALTER TABLE "mail" ADD CONSTRAINT "mail_delivery_check" CHECK ("mail"."delivery" IN ('pending','read','closed'));