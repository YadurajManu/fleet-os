ALTER TABLE status_checks ADD COLUMN metrics jsonb NOT NULL DEFAULT '{}';
