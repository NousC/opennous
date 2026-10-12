-- Product insights say what kind of feedback they are (GET-775).
--
-- Customer feedback on our features (a summary too long, a filter they want, a workspace that is
-- slow) used to be filed as the customer's pain. It is a product insight now, and `kind` says
-- whether it is a bug, a request, an improvement or praise, so product can filter it.
-- Nullable: only product insights carry one. The worker stores insights without it until this runs.
--
-- Safe to run more than once. Nothing here rewrites or drops a row.

alter table public.insight_items add column if not exists kind text;
alter table public.insight_items drop constraint if exists insight_items_kind_check;
alter table public.insight_items add constraint insight_items_kind_check
  check (kind is null or kind in ('bug', 'request', 'improvement', 'praise'));
