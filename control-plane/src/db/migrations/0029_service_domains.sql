CREATE TABLE "service_domains" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "service_id" uuid NOT NULL REFERENCES "services"("id") ON DELETE CASCADE,
  "host" text NOT NULL,
  "kind" text NOT NULL,
  "source" text NOT NULL,
  "challenge" text,
  "verified_at" timestamp with time zone,
  "tls_verified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "service_domains_kind_check" CHECK ("kind" IN ('managed_alias', 'custom')),
  CONSTRAINT "service_domains_source_check" CHECK ("source" IN ('api', 'manifest', 'legacy'))
);
CREATE UNIQUE INDEX "service_domains_host_key" ON "service_domains" ("host");
CREATE INDEX "service_domains_service_idx" ON "service_domains" ("service_id");

-- Preserve names that are serving traffic today. New claims require proof.
INSERT INTO "service_domains" ("service_id", "host", "kind", "source", "verified_at")
SELECT "id", lower("domain"), 'custom', 'legacy', now()
FROM "services" WHERE "domain" IS NOT NULL
ON CONFLICT ("host") DO NOTHING;
