CREATE TABLE task_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  reserved_cpu real NOT NULL,
  reserved_mem_bytes bigint NOT NULL,
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX task_reservations_node_idx ON task_reservations(node_id, expires_at);
