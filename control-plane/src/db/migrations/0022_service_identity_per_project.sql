-- A service is identified by (fleet, project, name), not by (fleet, name).
--
-- The `project` column has existed since 0002 and has been indexed since, but
-- it was never part of identity. So two projects in one fleet could not both
-- have a service called "backend": the second apply matched the first by name
-- and updated it in place, taking its volume, its deployments and its hostname
-- with it, and reported success.
--
-- The unique index is the enforcement; sync's lookup key changes with it.
DROP INDEX IF EXISTS "services_fleet_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "services_fleet_project_name_key"
  ON "services" ("fleet_id", "project", "name");

-- Deliberately NOT backfilling hostnames.
--
-- New services get a hostname carrying their project, so two "backend"s no
-- longer collide on services_hostname_key. Existing rows keep the hostname
-- they were deployed with: a URL somebody has bookmarked, or that another
-- service resolves, is not worth breaking for tidiness. The two schemes
-- coexist, and the unique index on hostname keeps them honest.
