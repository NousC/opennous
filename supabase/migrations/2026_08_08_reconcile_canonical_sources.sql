-- Auto-reconcile conflicting sources (P1) — the canonical-axis layer.
--
-- Problem: "Salesforce says churned, Stripe says paid" is a CROSS-FIELD conflict.
-- SF holds a state (lifecycle_stage), Stripe holds an event (invoice.paid) — different
-- properties, so the recency-based claim engine never compares them. This migration adds
-- the three primitives that make the conflict detectable and resolvable:
--   1. source_field_map  — projects each source's raw field/event onto ONE canonical axis.
--   2. source_authority  — per (canonical_property, source) trust, so "who wins" is defined.
--   3. field_conflicts   — the deduped, reviewable conflict surface ("see every conflict").
-- Additive; safe to re-run.
--
-- workspace_id NULL on the two config tables = a GLOBAL default (ships seeded below);
-- a matching workspace-scoped row overrides it.

-- ── 1. source_field_map ───────────────────────────────────────────────────────
create table if not exists source_field_map (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid,                        -- null = global default; ws row overrides
  source             text not null,               -- salesforce | hubspot | stripe | attio | ...
  match_kind         text not null,               -- state_field | event
  source_key         text not null,               -- 'lifecycle_stage' | 'invoice.paid'
  match              text,                         -- raw value to match (state_field); null = any (event)
  match_type         text not null default 'eq',  -- eq (casefold) | prefix | regex
  canonical_property text not null,               -- 'lifecycle'
  canonical_value    text not null,               -- 'prospect' | 'customer' | 'churned'
  event_validity     real,                        -- events: validity factor 0..1 (null -> 1.0)
  created_at         timestamptz not null default now()
);
create index if not exists source_field_map_lookup_idx
  on source_field_map (source, canonical_property);

-- ── 2. source_authority ───────────────────────────────────────────────────────
create table if not exists source_authority (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid,                        -- null = global default; ws row overrides
  canonical_property text not null,               -- 'lifecycle'
  source             text not null,               -- salesforce | stripe | ...
  authority          real not null,               -- 0..1 base trust for this axis
  event_ground_truth boolean not null default false,
  created_at         timestamptz not null default now()
);
-- One authority row per (property, source) at each scope. Nullable workspace_id means a
-- plain UNIQUE won't dedup globals (NULLs are distinct), so split into two partial indexes.
create unique index if not exists source_authority_global_uk
  on source_authority (canonical_property, source) where workspace_id is null;
create unique index if not exists source_authority_ws_uk
  on source_authority (workspace_id, canonical_property, source) where workspace_id is not null;

-- ── 3. field_conflicts ────────────────────────────────────────────────────────
-- One live row per (workspace, entity, canonical_property) — deduped like `flags`.
create table if not exists field_conflicts (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  entity_id          uuid not null,
  canonical_property text not null,               -- 'lifecycle'
  candidates         jsonb not null default '[]'::jsonb,
                     -- [{ value, source, observed_at, effective, observation_id }]
  resolved_value     jsonb,                       -- winner (null while pending)
  resolution         text not null default 'pending', -- pending | auto_resolved | human_resolved
  resolved_by        text,                        -- source name (auto) or user id (human)
  status             text not null default 'open',    -- open | resolved | dismissed
  created_at         timestamptz not null default now(),
  last_fired_at      timestamptz not null default now(),
  resolved_at        timestamptz,
  unique (workspace_id, entity_id, canonical_property)
);
create index if not exists field_conflicts_ws_status_idx
  on field_conflicts (workspace_id, status);
create index if not exists field_conflicts_entity_idx
  on field_conflicts (workspace_id, entity_id);

-- ── Seeds — GLOBAL defaults (workspace_id null) for the `lifecycle` axis ───────
-- Authority: Stripe is near-ground-truth for revenue; CRM stage is a human opinion.
insert into source_authority (workspace_id, canonical_property, source, authority, event_ground_truth)
values
  (null, 'lifecycle', 'stripe',     0.95, true),
  (null, 'lifecycle', 'salesforce', 0.50, false),
  (null, 'lifecycle', 'hubspot',    0.50, false),
  (null, 'lifecycle', 'attio',      0.50, false)
on conflict do nothing;

-- Field map: translate each source's raw lifecycle signal onto the canonical axis.
insert into source_field_map (workspace_id, source, match_kind, source_key, match, match_type, canonical_property, canonical_value, event_validity)
values
  -- Salesforce lifecycle_stage (state)
  (null, 'salesforce', 'state_field', 'lifecycle_stage', 'closed lost', 'eq',     'lifecycle', 'churned',  null),
  (null, 'salesforce', 'state_field', 'lifecycle_stage', 'churn',       'prefix', 'lifecycle', 'churned',  null),
  (null, 'salesforce', 'state_field', 'lifecycle_stage', 'closed won',  'eq',     'lifecycle', 'customer', null),
  (null, 'salesforce', 'state_field', 'lifecycle_stage', 'customer',    'eq',     'lifecycle', 'customer', null),
  -- HubSpot lifecyclestage (state)
  (null, 'hubspot',    'state_field', 'lifecyclestage',  'customer',    'eq',     'lifecycle', 'customer', null),
  (null, 'hubspot',    'state_field', 'lifecycle_stage', 'customer',    'eq',     'lifecycle', 'customer', null),
  -- Stripe (event -> state). A paid invoice ⇒ customer; a cancelled sub ⇒ churned.
  (null, 'stripe',     'event',       'invoice.paid',                  null, 'eq', 'lifecycle', 'customer', 1.0),
  (null, 'stripe',     'event',       'customer.subscription.deleted', null, 'eq', 'lifecycle', 'churned',  1.0)
on conflict do nothing;
