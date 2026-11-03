-- Clearance V2 - faceted catalogue browse (searchDocument + indexes).
--
-- ADDITIVE ONLY. Two nullable columns and two indexes; no existing column is
-- renamed, retyped, narrowed or dropped, and no row is rewritten. Existing
-- listings keep working with `searchDocument = NULL` until the idempotent
-- backfill derives a document for them (scripts/backfill-search-documents.ts).
--
-- `searchDocument` is the public browse wire shape (src/search/document.ts): a
-- result page reads this JSONB directly and needs no joins.
--
-- Index 1 (GIN on the document) supports containment/array filters such as
-- `searchDocument->'skills' ?| ARRAY[...]`.
-- Index 2 (GIN expression) is the full-text index behind
-- `websearch_to_tsquery('simple', $q)`; both `to_tsvector(regconfig, text)` and
-- the `coalesce` expression are immutable, so the index is usable by the query
-- planner. The expression is the ONE definition the query compiles to.

-- AlterTable
ALTER TABLE "JobListing" ADD COLUMN     "searchDocument" JSONB,
ADD COLUMN     "searchUpdatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "JobListing_searchDocument_gin_idx" ON "JobListing" USING GIN ("searchDocument");

-- CreateIndex
CREATE INDEX "JobListing_search_fts_gin_idx" ON "JobListing" USING GIN (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("company", '') || ' ' || coalesce("description", '')));
