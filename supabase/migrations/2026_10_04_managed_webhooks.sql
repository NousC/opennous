-- The "After every call" automation becomes a real webhook (GET-672).
--
-- Until now the Settings → Automations toggle set a hidden per-seat flag that a separate queue
-- (github_dispatches) read. Now the toggle owns a GitHub webhook in trigger_subscriptions: visible on
-- the Webhooks page, with the same delivery log, retries and test send as any other.
--
--   owner_user_id      the seat the webhook belongs to (its repo and token come from that seat)
--   managed_by         what created it and keeps it in sync: 'after_call' for the toggle; null for
--                      a webhook a person made by hand
--   github_event_type  the event_type to send instead of nous.<event>. The toggle's webhook sends
--                      nous.meeting_held, the name every after-call workflow already installed
--                      listens for, so nobody has to reinstall anything.
--
-- No data is written here. The worker reconciles each seat's webhook with its toggle and repo once
-- the new code is live, and the old queue skips any seat that has one, so no run is lost or doubled.
--
-- Run BEFORE deploying the GET-672 code. Idempotent.

ALTER TABLE public.trigger_subscriptions
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS managed_by text,
  ADD COLUMN IF NOT EXISTS github_event_type text;

-- One managed webhook of each kind per seat.
CREATE UNIQUE INDEX IF NOT EXISTS trigger_subscriptions_managed_unique
  ON public.trigger_subscriptions (workspace_id, owner_user_id, managed_by)
  WHERE managed_by IS NOT NULL;

COMMENT ON COLUMN public.trigger_subscriptions.managed_by IS
  'What keeps this webhook in sync: after_call (the Settings → Automations toggle). Null = made by hand. GET-672.';
COMMENT ON COLUMN public.trigger_subscriptions.github_event_type IS
  'GitHub destinations only: event_type sent instead of nous.<event>. GET-672.';
