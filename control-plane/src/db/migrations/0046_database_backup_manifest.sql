CREATE TYPE "public"."database_backup_kind" AS ENUM('base', 'wal', 'rdb', 'logical');--> statement-breakpoint
CREATE TYPE "public"."database_backup_state" AS ENUM('pending', 'running', 'complete', 'failed');--> statement-breakpoint
CREATE TABLE "database_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"database_id" uuid NOT NULL,
	"target_id" uuid,
	"operation_id" uuid,
	"node_id" uuid,
	"generation" integer NOT NULL,
	"engine" "database_engine" NOT NULL,
	"engine_version" text NOT NULL,
	"kind" "database_backup_kind" NOT NULL,
	"state" "database_backup_state" DEFAULT 'pending' NOT NULL,
	"object_prefix" text NOT NULL,
	"manifest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"size_bytes" bigint,
	"checksum_sha256" text,
	"recovery_point" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"label" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	CONSTRAINT "database_backups_generation_check" CHECK ("database_backups"."generation" > 0),
	CONSTRAINT "database_backups_size_check" CHECK ("database_backups"."size_bytes" is null or "database_backups"."size_bytes" >= 0),
	CONSTRAINT "database_backups_checksum_check" CHECK ("database_backups"."checksum_sha256" is null or "database_backups"."checksum_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "database_backups" ADD CONSTRAINT "database_backups_database_id_tenant_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."tenant_databases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_backups" ADD CONSTRAINT "database_backups_target_id_database_backup_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."database_backup_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_backups" ADD CONSTRAINT "database_backups_operation_id_database_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."database_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_backups" ADD CONSTRAINT "database_backups_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_backups_database_idx" ON "database_backups" USING btree ("database_id","created_at");--> statement-breakpoint
CREATE INDEX "database_backups_target_idx" ON "database_backups" USING btree ("target_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "database_backups_operation_idx" ON "database_backups" USING btree ("operation_id");