-- Insight themes become durable objects instead of a disposable cache.
--
-- THE BUG THIS FIXES. Membership lived in insight_themes.item_ids, and a rebuild ran
-- `delete() where workspace_id = …` then re-inserted every theme with a fresh uuid. The
-- cache key (build_key) was a sha1 of EVERY insight id, so one new insight from one call
-- invalidated the whole build. Meanwhile reporting_insight_state — the status and notes a
-- founder sets on a card — is keyed by the theme's uuid. So every rebuild orphaned every
-- status. Measured on 2026-09-20: every status row on a workspace was orphaned.
--
-- THE MODEL AFTER THIS. A theme is a row that persists. Membership is a column on the
-- ITEM (theme_id), not an array on the theme, which makes "what is not yet clustered"
-- a cheap indexed query instead of an array subtraction. New insights are ROUTED into
-- existing themes; only what fits nowhere pools up and triggers a consolidation pass.
-- Themes keep their id, so reporting_insight_state keeps resolving.
--
-- Apply by hand in the Supabase dashboard, like crm_property_schemas and
-- 2026_09_15_observation_deals.sql. Safe to re-run.

-- ── Membership moves onto the item ───────────────────────────────────────────
alter table public.insight_items
  add column if not exists theme_id uuid;

-- on delete set null: retiring a theme releases its members back to the unclustered
-- pool rather than leaving a dangling pointer. This is the guarantee that replaces the
-- delete-and-reinsert cycle.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'insight_items_theme_id_fkey'
  ) then
    alter table public.insight_items
      add constraint insight_items_theme_id_fkey
      foreign key (theme_id) references public.insight_themes(id) on delete set null;
  end if;
end $$;

create index if not exists insight_items_ws_theme_idx
  on public.insight_items (workspace_id, theme_id);

-- The unclustered pool — the query the nightly router runs first. Partial index so it
-- stays small no matter how large insight_items grows.
create index if not exists insight_items_ws_unclustered_idx
  on public.insight_items (workspace_id, source, category)
  where theme_id is null;

-- ── The theme's own aggregates ───────────────────────────────────────────────
-- Denormalized caches of an aggregate over the members (NOT a second source of truth for
-- membership itself — they are recomputed from theme_id every time membership changes).
--
-- call_count is the honest measure of a pattern: item_count counts rows, and one chatty
-- call can manufacture a dozen of them. A workspace can show many themes that all come from a SINGLE call.
alter table public.insight_themes
  add column if not exists call_count   integer not null default 0,
  add column if not exists people_count integer not null default 0,
  add column if not exists first_seen_at timestamptz,
  add column if not exists last_seen_at  timestamptz,
  -- A theme whose members all moved elsewhere. Kept, not deleted, so any
  -- reporting_insight_state row pointing at it still resolves to something nameable.
  add column if not exists retired_at   timestamptz;

create index if not exists insight_themes_ws_src_cat_rank_idx
  on public.insight_themes (workspace_id, source, category, rank);

-- ── Backfill: adopt the current arrays as the new membership ─────────────────
-- One-time, idempotent. Existing themes keep their uuid, so whatever status rows are
-- still live stay live. Themes are NOT rebuilt here — the worker does that on its next
-- run, and from then on it routes instead of rebuilding.
update public.insight_items i
   set theme_id = t.id
  from public.insight_themes t
 where t.workspace_id = i.workspace_id
   and i.theme_id is null
   and i.id = any (t.item_ids);

-- build_key is no longer read: the whole-corpus hash WAS the bug. Left in place rather
-- than dropped (a dropped column is the one thing a revert cannot undo), but nothing
-- writes it after this migration.
comment on column public.insight_themes.build_key is
  'DEPRECATED 2026-09-20. Was a sha1 of every insight id, which made one new insight invalidate every theme. Unused; see insight_items.theme_id.';
comment on column public.insight_themes.item_ids is
  'Denormalized mirror of insight_items.theme_id, rewritten whenever membership changes. theme_id is authoritative.';
