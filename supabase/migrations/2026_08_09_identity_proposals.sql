-- Piece 4 of auto-reconcile: identity approve/deny.
--
-- When a person is ingested and resolution is confident (exact identifier) we attach
-- silently. When it's only PLAUSIBLE (a fuzzy name/email-local match), we no longer either
-- guess-fuse or silently fork a duplicate — we record a proposal so a human confirms the
-- merge. One live row per (workspace, subject entity).
-- Additive; safe to re-run.

create table if not exists identity_proposals (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  entity_id      uuid not null,                 -- the subject (the just-ingested / newer entity)
  kind           text not null default 'merge', -- merge | attach
  candidates     jsonb not null default '[]'::jsonb,
                 -- [{ entity_id, confidence, reason }] ranked best-first
  stakes         text not null default 'high',  -- high | low
  status         text not null default 'pending', -- pending | approved | denied | dismissed
  resolved_by    text,
  created_at     timestamptz not null default now(),
  last_fired_at  timestamptz not null default now(),
  resolved_at    timestamptz,
  -- One live proposal per subject entity — deduped like flags/field_conflicts.
  unique (workspace_id, entity_id)
);
create index if not exists identity_proposals_ws_status_idx
  on identity_proposals (workspace_id, status);
create index if not exists identity_proposals_entity_idx
  on identity_proposals (workspace_id, entity_id);
