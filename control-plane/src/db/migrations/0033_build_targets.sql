ALTER TABLE services ADD COLUMN build_dockerfile text NOT NULL DEFAULT 'Dockerfile';
--> statement-breakpoint
ALTER TABLE services ADD COLUMN build_target text;
--> statement-breakpoint
ALTER TABLE nodes ADD COLUMN build_targets boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE nodes ADD COLUMN task_run boolean NOT NULL DEFAULT false;
