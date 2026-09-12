-- Adds a cardinality label (1:1, 1:M, M:M, 1:0, 0:M) to confirmed
-- relationships, chosen via the type popup in the Relationships tab.
-- Nullable: existing rows and any inserted without a chosen type stay
-- untyped rather than defaulting to a guess.
alter table public.workspace_relationships
  add column if not exists cardinality text;
