-- Account visibility should default to CLOSED (owners-only), not open.
-- A governance layer under-shares until a team deliberately opens up. This flips the
-- DEFAULT for NEW workspaces only; existing rows keep whatever they were explicitly set to
-- (the original column was NOT NULL DEFAULT true, so today's workspaces stay open until an
-- owner/admin turns the toggle off). Pairs with the code fallback in visibility.mjs /
-- workspaces.mjs, which now reads an unset value as closed. Additive; safe to re-run.

ALTER TABLE public.workspaces
  ALTER COLUMN open_account_visibility SET DEFAULT false;

COMMENT ON COLUMN public.workspaces.open_account_visibility IS
  'When false (default), a member sees only accounts they own / are in touch with; owners+admins always see all. When true, every member sees all accounts. New workspaces start closed.';
