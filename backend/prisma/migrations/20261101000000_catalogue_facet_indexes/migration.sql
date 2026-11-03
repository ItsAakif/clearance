-- Clearance catalogue performance: facet indexes.
--
-- The browse query filters on `"isActive"` (the active catalogue) and groups by
-- JSONB expressions / the effective date. A partial expression index lets those
-- groupings read a narrow, covering index instead of the wide `searchDocument`
-- heap. The partial predicate is exactly `"isActive"`, so the query MUST carry
-- `"isActive" = true` (see buildCatalogueWhere in src/search/store.ts).
--
-- `CREATE INDEX IF NOT EXISTS` keeps this migration idempotent for databases
-- where the same indexes were pre-created CONCURRENTLY by an operator. On a
-- fresh database they are built normally.
--
-- Skills are deliberately NOT given another index here: facet counting expands
-- `searchDocument->'skills'` and cannot use a GIN posting list for an aggregate.
-- The existing GIN index still serves the `?|` skill FILTER. Skills are one
-- separate aggregation over the same filtered rows.

CREATE INDEX IF NOT EXISTS "JobListing_active_region_expr_idx"
  ON "JobListing" ((("searchDocument"->>'region'))) WHERE "isActive";

CREATE INDEX IF NOT EXISTS "JobListing_active_workmode_expr_idx"
  ON "JobListing" ((("searchDocument"->>'workMode'))) WHERE "isActive";

CREATE INDEX IF NOT EXISTS "JobListing_active_seniority_expr_idx"
  ON "JobListing" ((("searchDocument"->>'seniority'))) WHERE "isActive";

CREATE INDEX IF NOT EXISTS "JobListing_active_specialization_expr_idx"
  ON "JobListing" ((("searchDocument"->>'specialization'))) WHERE "isActive";

CREATE INDEX IF NOT EXISTS "JobListing_active_source_expr_idx"
  ON "JobListing" ((("searchDocument"->>'source'))) WHERE "isActive";

CREATE INDEX IF NOT EXISTS "JobListing_active_effective_date_idx"
  ON "JobListing" ((coalesce("postedAt", "firstSeenAt"))) WHERE "isActive";

ANALYZE "JobListing";
