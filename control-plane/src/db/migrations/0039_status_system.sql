CREATE TABLE status_components (
 id text PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL, description text NOT NULL DEFAULT '',
 "group" text NOT NULL, public boolean NOT NULL DEFAULT true, sort integer NOT NULL DEFAULT 0, depends_on text[] NOT NULL DEFAULT '{}'
);
CREATE TABLE status_checks (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, component_id text NOT NULL REFERENCES status_components(id), ts timestamptz NOT NULL,
 ok boolean, latency_ms real, status_code integer, error text, legacy_sample_id bigint UNIQUE
);
CREATE INDEX status_checks_component_time_idx ON status_checks(component_id,ts);
CREATE TABLE status_rollups (
 component_id text NOT NULL REFERENCES status_components(id), bucket timestamptz NOT NULL, granularity text NOT NULL CHECK (granularity IN ('hour','day')),
 checks integer NOT NULL CHECK(checks>=0), ok_checks integer NOT NULL CHECK(ok_checks>=0 AND ok_checks<=checks), p50 real,p95 real,p99 real,downtime_s real NOT NULL DEFAULT 0,
 CONSTRAINT status_rollups_component_bucket_idx UNIQUE(component_id,bucket,granularity)
);
CREATE TABLE status_incidents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text NOT NULL,impact text NOT NULL,status text NOT NULL,
 started_at timestamptz NOT NULL,resolved_at timestamptz,auto boolean NOT NULL DEFAULT false,legacy_event_id bigint UNIQUE
);
CREATE TABLE incident_components (incident_id uuid NOT NULL REFERENCES status_incidents(id),component_id text NOT NULL REFERENCES status_components(id),PRIMARY KEY(incident_id,component_id));
CREATE TABLE incident_updates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),incident_id uuid NOT NULL REFERENCES status_incidents(id),status text NOT NULL,body text NOT NULL,ts timestamptz NOT NULL);
CREATE INDEX incident_updates_time_idx ON incident_updates(incident_id,ts);
CREATE TABLE maintenance_windows (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text NOT NULL,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL CHECK(ends_at>starts_at));
CREATE TABLE maintenance_components (maintenance_id uuid NOT NULL REFERENCES maintenance_windows(id),component_id text NOT NULL REFERENCES status_components(id),PRIMARY KEY(maintenance_id,component_id));
CREATE TABLE status_subscribers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),channel text NOT NULL CHECK(channel IN ('email','webhook')),target text NOT NULL,component_ids text[] NOT NULL DEFAULT '{}',verified_at timestamptz,token text NOT NULL UNIQUE);
CREATE TABLE status_prober_heartbeat (id text PRIMARY KEY,at timestamptz NOT NULL);
CREATE TABLE status_component_state (component_id text PRIMARY KEY REFERENCES status_components(id),status text NOT NULL DEFAULT 'unknown',failures integer NOT NULL DEFAULT 0,successes integer NOT NULL DEFAULT 0,degraded_since timestamptz,checked_at timestamptz,monitoring_since timestamptz);
INSERT INTO status_components(id,slug,name,"group",sort,public,depends_on) VALUES
 ('api','api','Control plane API','Core',0,true,'{postgres,redis}'),('postgres','postgres','Postgres','Core',1,true,'{}'),('redis','redis','Redis','Core',2,true,'{}'),('registry','registry','Registry storage','Core',3,true,'{}'),
 ('ingress','ingress','Ingress (Caddy)','Platform',4,true,'{}'),('tunnel','tunnel','Tunnel gateway','Platform',5,true,'{ingress}'),('build','build','Build pipeline','Platform',6,true,'{registry,docker-hub}'),('scheduler','scheduler','Scheduler','Platform',7,true,'{postgres,tunnel}'),('logs','logs','Log streaming','Platform',8,true,'{tunnel}'),
 ('github-app','github-app','GitHub App & webhooks','Integrations',9,true,'{github}'),('cli-auth','cli-auth','CLI authentication','Integrations',10,true,'{api}'),
 ('website','website','Website','Web',11,true,'{}'),('docs','docs','Docs','Web',12,true,'{}'),('dashboard','dashboard','Dashboard','Web',13,true,'{api}'),
 ('github','github','GitHub','Third-party',14,false,'{}'),('npm','npm','npm','Third-party',15,false,'{}'),('docker-hub','docker-hub','Docker Hub','Third-party',16,false,'{}');
--> statement-breakpoint
-- Keep legacy data intact; all historical import operations can be replayed safely.
INSERT INTO status_checks(component_id,ts,ok,legacy_sample_id)
 SELECT component,checked_at,CASE WHEN status='unknown' THEN NULL ELSE status='operational' END,id
 FROM public_status_samples WHERE component IN (SELECT id FROM status_components) ON CONFLICT(legacy_sample_id) DO NOTHING;
INSERT INTO status_component_state(component_id,status,checked_at,monitoring_since)
 SELECT component,'unknown',max(checked_at),min(checked_at) FROM public_status_samples
 WHERE component IN (SELECT id FROM status_components) GROUP BY component ON CONFLICT(component_id) DO NOTHING;
INSERT INTO status_rollups(component_id,bucket,granularity,checks,ok_checks,downtime_s)
 SELECT component_id,date_trunc(g,ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',g,count(ok)::int,count(*) FILTER(WHERE ok)::int,count(*) FILTER(WHERE ok=false)*30
 FROM status_checks CROSS JOIN (VALUES ('hour'),('day')) AS grains(g) GROUP BY component_id,g,date_trunc(g,ts AT TIME ZONE 'UTC')
 ON CONFLICT(component_id,bucket,granularity) DO NOTHING;
INSERT INTO status_incidents(title,impact,status,started_at,resolved_at,auto,legacy_event_id)
 SELECT c.name || ' health event',CASE WHEN e.status='outage' THEN 'major_outage' WHEN e.status='degraded' THEN 'degraded' ELSE 'operational' END,
 'resolved',e.occurred_at,e.occurred_at,true,e.id FROM public_status_events e JOIN status_components c ON c.id=e.component
 ON CONFLICT(legacy_event_id) DO NOTHING;
INSERT INTO incident_components(incident_id,component_id)
 SELECT i.id,e.component FROM status_incidents i JOIN public_status_events e ON e.id=i.legacy_event_id ON CONFLICT DO NOTHING;
INSERT INTO incident_updates(incident_id,status,body,ts)
 SELECT i.id,'resolved','Historical component health event imported from the previous monitor.',i.started_at FROM status_incidents i
 WHERE i.legacy_event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM incident_updates u WHERE u.incident_id=i.id);
