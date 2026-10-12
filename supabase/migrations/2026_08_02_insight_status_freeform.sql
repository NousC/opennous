-- Status is category-specific now (Product ships, blockers resolve, decisions reverse);
-- the app owns the vocabulary, so drop the fixed CHECK. Column stays non-empty text.
alter table public.insight_items drop constraint if exists insight_items_status_check;
alter table public.insight_themes drop constraint if exists insight_themes_status_check;
