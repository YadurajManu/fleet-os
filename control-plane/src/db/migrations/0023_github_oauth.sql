-- GitHub OAuth 2.0 social login.
--
-- Adds support for signing in with GitHub, linking existing accounts,
-- and storing GitHub username and avatar. Makes password_hash nullable
-- so users who authenticate exclusively via GitHub do not need a dummy password.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "github_id" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "github_username" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" text;
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "users_github_id_key"
  ON "users" ("github_id");
