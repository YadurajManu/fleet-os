ALTER TABLE nodes ADD COLUMN build_cpu_millis boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE deployments ADD COLUMN warnings text[] NOT NULL DEFAULT '{}';
