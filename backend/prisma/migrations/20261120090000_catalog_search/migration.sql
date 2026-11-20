-- Milestone 4a: catalog search, specifications and deal countdowns.
-- Hand-written: Prisma can't express generated columns, GIN indexes on them, or CHECK rules.

-- Typo-tolerant matching ("hedphones" still finds "Headphones").
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- "Specifications" tab: a list of { label, value } pairs.
ALTER TABLE "products" ADD COLUMN "specs" JSONB NOT NULL DEFAULT '[]';

-- Full-text search, kept up to date by PostgreSQL itself on every insert/update.
-- The title counts more than the description (weights A and B). 'english' turns
-- "headphone" and "headphones" into the same word.
ALTER TABLE "products" ADD COLUMN "searchVector" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english'::regconfig, coalesce("title", '')), 'A') ||
  setweight(to_tsvector('english'::regconfig, coalesce("description", '')), 'B')
) STORED;

CREATE INDEX "products_searchVector_idx" ON "products" USING GIN ("searchVector");
CREATE INDEX "products_title_trgm_idx" ON "products" USING GIN ("title" gin_trgm_ops);

-- Deal countdown: after saleEndsAt the deal is over and the variant sells at compareAtCentavos again.
ALTER TABLE "product_variants" ADD COLUMN "saleEndsAt" TIMESTAMPTZ(3);

-- Hand-written safety rules
ALTER TABLE "products" ADD CONSTRAINT "products_specs_chk" CHECK (jsonb_typeof("specs") = 'array' AND jsonb_array_length("specs") <= 30);
-- A deal can only end if there is a regular price to go back to.
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_sale_end_chk" CHECK ("saleEndsAt" IS NULL OR "compareAtCentavos" IS NOT NULL);
