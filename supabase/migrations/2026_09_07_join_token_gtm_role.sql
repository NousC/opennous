-- Pre-assign the invitee's identity + roles on the join token, so a teammate who redeems
-- `nous join <token>` lands already scoped: their WORKSPACE role (member/admin) and their GTM
-- role (AE/SDR/RevOps/…) are set the moment they join — role-report and the role-scoped
-- experience work from their very first onboarding, with no "set your role later" step.
--
-- Additive + safe: three new nullable columns on an existing table. Nothing changes for the
-- existing member/viewer/domain/department fields.

alter table team_join_tokens
  add column if not exists job_role      text,   -- GTM role applied to users.job_roles on join
  add column if not exists invitee_name  text,   -- for the members-page display + audit
  add column if not exists invitee_email text;   -- ditto (and future domain/email checks)
