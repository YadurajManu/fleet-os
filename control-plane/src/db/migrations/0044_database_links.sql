CREATE TABLE "database_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"database_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"role" text DEFAULT 'app' NOT NULL,
	"env_keys" jsonb NOT NULL,
	"applied_generation" integer DEFAULT 0 NOT NULL,
	"restart_required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_links_role_check" CHECK ("database_links"."role" in ('app', 'readonly')),
	CONSTRAINT "database_links_generation_check" CHECK ("database_links"."applied_generation" >= 0)
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "preferred_node_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "database_links" ADD CONSTRAINT "database_links_database_id_tenant_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."tenant_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_links" ADD CONSTRAINT "database_links_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "database_links_pair_idx" ON "database_links" USING btree ("database_id","service_id");--> statement-breakpoint
CREATE INDEX "database_links_service_idx" ON "database_links" USING btree ("service_id");