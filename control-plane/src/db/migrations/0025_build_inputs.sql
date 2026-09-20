ALTER TABLE services ADD COLUMN build_args jsonb NOT NULL DEFAULT '{}'::jsonb,
 ADD COLUMN build_secret_refs text[] NOT NULL DEFAULT '{}';
