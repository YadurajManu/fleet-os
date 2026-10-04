CREATE TABLE platform_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_key text NOT NULL UNIQUE,
  kind text NOT NULL,
  target_id uuid,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  evidence_at timestamptz NOT NULL,
  resolved_at timestamptz,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX platform_incidents_status_idx ON platform_incidents(status, last_observed_at);
CREATE TABLE platform_incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES platform_incidents(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  note text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_incident_events_incident_idx ON platform_incident_events(incident_id, at);
CREATE TABLE platform_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_id uuid,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_access_events_at_idx ON platform_access_events(at);
