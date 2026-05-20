ALTER TABLE "client_devices" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "client_devices_revoked" ON "client_devices" USING btree ("device_id","revoked_at");