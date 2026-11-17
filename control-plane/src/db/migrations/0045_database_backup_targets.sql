CREATE TABLE "database_backup_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fleet_id" uuid NOT NULL,
	"project" text NOT NULL,
	"name" text NOT NULL,
	"endpoint" text NOT NULL,
	"bucket" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"region" text DEFAULT 'us-east-1' NOT NULL,
	"encrypted_credentials" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"last_tested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_backup_targets_project_check" CHECK (length("database_backup_targets"."project") between 1 and 128),
	CONSTRAINT "database_backup_targets_name_check" CHECK (length("database_backup_targets"."name") between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "tenant_databases" ADD COLUMN "backup_target_id" uuid;--> statement-breakpoint
ALTER TABLE "database_backup_targets" ADD CONSTRAINT "database_backup_targets_fleet_id_fleets_id_fk" FOREIGN KEY ("fleet_id") REFERENCES "public"."fleets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "database_backup_targets_name_idx" ON "database_backup_targets" USING btree ("fleet_id","project","name");--> statement-breakpoint
CREATE UNIQUE INDEX "database_backup_targets_default_idx" ON "database_backup_targets" USING btree ("fleet_id","project") WHERE "database_backup_targets"."is_default";--> statement-breakpoint
ALTER TABLE "tenant_databases" ADD CONSTRAINT "tenant_databases_backup_target_id_database_backup_targets_id_fk" FOREIGN KEY ("backup_target_id") REFERENCES "public"."database_backup_targets"("id") ON DELETE set null ON UPDATE no action;