-- Operator support access, as a real membership that expires and that the customer can see.
--
-- We need to get into a customer's workspace when something breaks. The tempting way to build
-- that is an ambient bypass in every membership check — 97 of them — which is a permanent
-- unlogged backdoor into other people's revenue data and the first thing that fails a security
-- review.
--
-- So instead it is a real `workspace_members` row with an expiry. Every existing check works
-- unchanged; the operator appears in the members list, which is a FEATURE not a leak (the
-- customer can see we are in there); and it stops working on its own.
alter table public.workspace_members
  add column if not exists support_until  timestamptz,
  add column if not exists support_reason text;

create index if not exists workspace_members_support_until_idx
  on public.workspace_members (support_until) where support_until is not null;

comment on column public.workspace_members.support_until is
  'Set only on operator support access. The row is deleted when it passes — see worker sweepSupportAccess.';
