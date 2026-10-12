-- workflow_providers.scope — whose tool a provider is.
--
-- 'workspace': one connection covers the company (a CRM, a sequencer, Stripe). The founder
--              connects it once and every seat reads the same pipeline; backfilling one
--              reconstructs the whole book, which is what the revenue report is built on.
-- 'personal':  one connection covers ONE person (a notetaker, a mailbox, a calendar). Every
--              seat connects their own, and their backfill covers their activity alone.
--
-- The catalogue file is the truth (providers/catalogue.mjs → scopeOf); this column is its
-- projection, rewritten on every API boot. Defaulting to 'workspace' keeps existing rows
-- valid until that boot lands.
alter table public.workflow_providers
  add column if not exists scope text not null default 'workspace';

alter table public.workflow_providers
  drop constraint if exists workflow_providers_scope_check;

alter table public.workflow_providers
  add constraint workflow_providers_scope_check check (scope in ('workspace', 'personal'));
