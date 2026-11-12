CREATE TABLE IF NOT EXISTS public_status_samples (
  id bigserial PRIMARY KEY,
  component text NOT NULL,
  status text NOT NULL CHECK (status IN ('operational','degraded','outage','unknown')),
  checked_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS public_status_samples_component_time_idx ON public_status_samples(component, checked_at DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public_status_events (
  id bigserial PRIMARY KEY,
  component text NOT NULL,
  status text NOT NULL CHECK (status IN ('operational','degraded','outage')),
  message text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS public_status_events_time_idx ON public_status_events(occurred_at DESC);
