-- A webhook can post to a Slack channel (GET-941).
--
-- destination_type 'slack' keeps the channel's incoming webhook in `url` (hooks.slack.com only,
-- checked in core: db/triggers.ts SLACK_WEBHOOK_RE). Each event goes out as a short Slack message
-- instead of the signed JSON: same catalog, outbox, retries and delivery log as a URL webhook. The
-- incoming webhook is a credential, so the API never returns it whole.
--
-- Idempotent.

ALTER TABLE public.trigger_subscriptions DROP CONSTRAINT IF EXISTS trigger_subscriptions_destination_check;
ALTER TABLE public.trigger_subscriptions
  ADD CONSTRAINT trigger_subscriptions_destination_check CHECK (
    (destination_type = 'url'    AND url IS NOT NULL)
 OR (destination_type = 'github' AND github_repo IS NOT NULL AND github_token_enc IS NOT NULL)
 OR (destination_type = 'slack'  AND url IS NOT NULL)
  );

COMMENT ON COLUMN public.trigger_subscriptions.destination_type IS
  'url (POST a signed JSON body), github (repository_dispatch to github_repo) or slack (a message to the incoming webhook in url). GET-670, GET-941.';

NOTIFY pgrst, 'reload schema';
