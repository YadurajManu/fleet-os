CREATE TYPE "public"."database_engine" AS ENUM('postgres', 'redis');--> statement-breakpoint
CREATE TYPE "public"."database_operation_kind" AS ENUM('create', 'start', 'stop', 'restart', 'delete', 'purge', 'backup', 'restore', 'recover', 'import', 'dump', 'migrate', 'exec', 'tune', 'extension', 'rotate', 'link', 'unlink');--> statement-breakpoint
CREATE TYPE "public"."database_operation_state" AS ENUM('queued', 'running', 'reconciling', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."database_status" AS ENUM('provisioning', 'running', 'stopped', 'unreachable', 'degraded', 'restoring', 'failed', 'deleting');--> statement-breakpoint
CREATE TABLE "database_credentials" (
	"database_id" uuid NOT NULL,
	"role" text NOT NULL,
	"encrypted_value" jsonb NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_credentials_database_id_role_pk" PRIMARY KEY("database_id","role"),
	CONSTRAINT "database_credentials_role_check" CHECK ("database_credentials"."role" in ('owner', 'app', 'readonly'))
);
--> statement-breakpoint
CREATE TABLE "database_operation_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"code" text NOT NULL,
	"progress" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_operation_events_progress_check" CHECK ("database_operation_events"."progress" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "database_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"database_id" uuid NOT NULL,
	"kind" "database_operation_kind" NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"encrypted_input" jsonb NOT NULL,
	"state" "database_operation_state" DEFAULT 'queued' NOT NULL,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generation" integer NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"progress" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "database_operations_progress_check" CHECK ("database_operations"."progress" between 0 and 100 and "database_operations"."attempts" >= 0 and "database_operations"."generation" > 0),
	CONSTRAINT "database_operations_key_check" CHECK (length("database_operations"."idempotency_key") between 1 and 128)
);
--> statement-breakpoint
CREATE TABLE "tenant_databases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fleet_id" uuid NOT NULL,
	"project" text NOT NULL,
	"name" text NOT NULL,
	"engine" "database_engine" NOT NULL,
	"version" text NOT NULL,
	"mode" text DEFAULT 'standard' NOT NULL,
	"status" "database_status" DEFAULT 'provisioning' NOT NULL,
	"desired_state" text DEFAULT 'running' NOT NULL,
	"node_id" uuid,
	"volume_name" text NOT NULL,
	"memory_mb" integer NOT NULL,
	"cpu" real NOT NULL,
	"disk_mb" integer NOT NULL,
	"profile" text DEFAULT 'standard' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	CONSTRAINT "tenant_databases_name_check" CHECK ("tenant_databases"."name" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "tenant_databases_project_check" CHECK (length("tenant_databases"."project") between 1 and 128),
	CONSTRAINT "tenant_databases_resources_check" CHECK ("tenant_databases"."memory_mb" >= 128 and "tenant_databases"."cpu" > 0 and "tenant_databases"."cpu" <= 1024 and "tenant_databases"."disk_mb" >= 1024 and "tenant_databases"."generation" > 0),
	CONSTRAINT "tenant_databases_mode_check" CHECK (("tenant_databases"."engine" = 'postgres' and "tenant_databases"."mode" = 'standard') or ("tenant_databases"."engine" = 'redis' and "tenant_databases"."mode" in ('cache', 'durable'))),
	CONSTRAINT "tenant_databases_desired_check" CHECK ("tenant_databases"."desired_state" in ('running', 'stopped')),
	CONSTRAINT "tenant_databases_profile_check" CHECK ("tenant_databases"."profile" in ('dev', 'standard', 'performance'))
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "database_capabilities" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "database_credentials" ADD CONSTRAINT "database_credentials_database_id_tenant_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."tenant_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_operation_events" ADD CONSTRAINT "database_operation_events_operation_id_database_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."database_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_operations" ADD CONSTRAINT "database_operations_database_id_tenant_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."tenant_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_databases" ADD CONSTRAINT "tenant_databases_fleet_id_fleets_id_fk" FOREIGN KEY ("fleet_id") REFERENCES "public"."fleets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_databases" ADD CONSTRAINT "tenant_databases_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_operation_events_cursor_idx" ON "database_operation_events" USING btree ("operation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "database_operations_idempotency_idx" ON "database_operations" USING btree ("database_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "database_operations_active_idx" ON "database_operations" USING btree ("database_id") WHERE "database_operations"."state" in ('queued', 'running', 'reconciling');--> statement-breakpoint
CREATE INDEX "database_operations_claim_idx" ON "database_operations" USING btree ("state","lease_expires_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_databases_name_idx" ON "tenant_databases" USING btree ("fleet_id","project","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_databases_volume_idx" ON "tenant_databases" USING btree ("volume_name");--> statement-breakpoint
CREATE INDEX "tenant_databases_node_idx" ON "tenant_databases" USING btree ("node_id");