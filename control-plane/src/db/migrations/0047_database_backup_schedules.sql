CREATE TABLE "database_backup_schedules" (
	"database_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_queued_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "database_backup_schedules" ADD CONSTRAINT "database_backup_schedules_database_id_tenant_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."tenant_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_backup_schedules_due_idx" ON "database_backup_schedules" USING btree ("enabled","next_run_at");
--> statement-breakpoint
INSERT INTO "database_backup_schedules" ("database_id", "enabled", "next_run_at")
SELECT "id", true, now() + interval '1 day'
FROM "tenant_databases"
WHERE "backup_target_id" IS NOT NULL
  AND "deleted_at" IS NULL
  AND ("engine" = 'postgres' OR ("engine" = 'redis' AND "mode" = 'durable'));
