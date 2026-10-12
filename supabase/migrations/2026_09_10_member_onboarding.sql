-- Per-seat onboarding.
--
-- Onboarding was a property of the WORKSPACE: once the founder finished, the workspace was
-- activated and every seat after them walked into a product nobody had introduced. But the
-- founder's setup and a rep's setup are different jobs — the founder connects the company's
-- CRM, the rep connects their own notetaker and mailbox, and only the rep can do the second.
-- So the state belongs on the membership, not on the workspace.
--
-- NULL = this seat has never been through it. A timestamp = they have, and they are left alone.
alter table public.workspace_members
  add column if not exists onboarded_at timestamptz;

-- What THIS seat asked us to write when their own backfill lands. The workspace-level column
-- stays for the founder's whole-book reports; this is the personal read.
alter table public.workspace_members
  add column if not exists onboarding_reports jsonb;

comment on column public.workspace_members.onboarded_at is
  'When this seat finished their own welcome conversation. NULL = never onboarded; the router nudges them into it.';

-- Every seat that predates this column has already been using the product, so backfill them
-- as onboarded. Nudging existing users into a setup conversation for a workspace that is
-- already running would be the change announcing itself as a bug.
update public.workspace_members
   set onboarded_at = coalesce(onboarded_at, created_at)
 where onboarded_at is null;
