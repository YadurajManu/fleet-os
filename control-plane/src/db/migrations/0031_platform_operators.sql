CREATE TABLE IF NOT EXISTS "platform_operators" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "granted_at" timestamptz NOT NULL DEFAULT now()
);
