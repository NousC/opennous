-- Rename the playbooks table → foundations.
--
-- "Playbook" stopped fitting once the Vault holds two doc types: context docs the
-- user authors (voice, outreach, icp, positioning) and insights Nous learns from
-- calls. The authored docs are the "foundations"; get_playbook/sync_playbook are
-- now get_foundation/sync_foundation. This preserves all rows and the unique
-- (workspace_id, kind) slotting; only names change.
--
-- NOTE: the fact-provenance value source='playbook' and the subject slots
-- 'playbook.*' on the claims table are a DIFFERENT concept (how a belief was
-- authored) and are intentionally NOT renamed here — renaming them would orphan
-- existing rows. Likewise the gtm_playbook onboarding-status key and the
-- workspaces.playbook_rebuild_count counter are left as-is.

ALTER TABLE public.playbooks RENAME TO foundations;

ALTER TABLE public.foundations RENAME CONSTRAINT playbooks_kind_check TO foundations_kind_check;
ALTER TABLE public.foundations RENAME CONSTRAINT playbooks_source_check TO foundations_source_check;
ALTER TABLE public.foundations RENAME CONSTRAINT playbooks_pkey TO foundations_pkey;
ALTER TABLE public.foundations RENAME CONSTRAINT playbooks_workspace_id_kind_key TO foundations_workspace_id_kind_key;
ALTER INDEX public.playbooks_workspace_idx RENAME TO foundations_workspace_idx;
