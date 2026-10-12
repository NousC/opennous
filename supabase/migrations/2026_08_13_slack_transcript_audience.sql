-- Audience-filtered transcripts (the trust layer) for the SHARED Slack surface.
--
-- A Slack channel's history is shared across everyone in it, but the accounts a turn
-- discussed may be outside a given viewer's book. We tag each stored turn with the
-- account entity ids it touched (resolved by the agent's single-entity tools), so that
-- when the thread is replayed for the NEXT asker, turns about accounts they can't see
-- are substituted — redact by substitution, not by dropping, keeping the conversation
-- coherent. NULL / empty = a general turn (no specific account) → never redacted.

ALTER TABLE slack_thread_messages
  ADD COLUMN IF NOT EXISTS account_entity_ids UUID[];

COMMENT ON COLUMN slack_thread_messages.account_entity_ids IS
  'Account entity ids this turn touched. On replay, a turn is redacted for a viewer who cannot see any of these. NULL/empty = general turn, never redacted.';
