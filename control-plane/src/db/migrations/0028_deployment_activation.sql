ALTER TABLE "deployments" ADD COLUMN "activated_at" timestamp with time zone;
UPDATE "deployments" SET "activated_at" = COALESCE("finished_at", now()) WHERE "status" = 'running';
