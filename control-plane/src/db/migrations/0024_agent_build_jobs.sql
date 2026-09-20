-- Additive: v0.2.4 registration and heartbeats omit all new fields.
ALTER TABLE nodes ADD COLUMN platform text,
 ADD COLUMN variant text, ADD COLUMN engine_kind text,
 ADD COLUMN effective_cpu real CHECK (effective_cpu > 0),
 ADD COLUMN effective_mem_bytes bigint CHECK (effective_mem_bytes > 0),
 ADD COLUMN reliability_score real NOT NULL DEFAULT 0.5 CHECK (reliability_score BETWEEN 0 AND 1),
 ADD COLUMN can_build boolean NOT NULL DEFAULT false,
 ADD COLUMN platforms text[] NOT NULL DEFAULT '{}',
 ADD COLUMN max_concurrent_builds integer NOT NULL DEFAULT 1 CHECK (max_concurrent_builds BETWEEN 1 AND 16),
 ADD COLUMN build_cache_free_bytes bigint NOT NULL DEFAULT 0 CHECK (build_cache_free_bytes >= 0);
--> statement-breakpoint
ALTER TABLE services ADD COLUMN platforms jsonb NOT NULL DEFAULT '"auto"'::jsonb,
 ADD COLUMN placement_arch text,
 ADD COLUMN allow_emulation boolean NOT NULL DEFAULT false,
 ADD COLUMN image_platforms text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE TABLE build_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
 service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
 platform text NOT NULL, source_ref text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','assigned','running','succeeded','failed','cancelled','timed_out')),
 builder_node_id uuid REFERENCES nodes(id) ON DELETE SET NULL,
 attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
 lease_expires_at timestamptz, started_at timestamptz, finished_at timestamptz,
 image_digest text, error text,
 reserved_cpu real NOT NULL DEFAULT 2 CHECK (reserved_cpu > 0),
 reserved_mem_bytes bigint NOT NULL DEFAULT 2147483648 CHECK (reserved_mem_bytes > 0),
 created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX build_jobs_deployment_idx ON build_jobs(deployment_id);
CREATE INDEX build_jobs_lease_idx ON build_jobs(status, lease_expires_at);
CREATE INDEX build_jobs_cache_idx ON build_jobs(service_id, source_ref, platform);
