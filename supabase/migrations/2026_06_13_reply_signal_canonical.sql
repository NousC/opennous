-- Remap legacy reply-outcome values to the canonical reply-signal taxonomy.
--
-- The lead-list "reply_outcome" surfaces the `sentiment` claim. Before classifier
-- consolidation, two writers used two vocabularies: the sentiment classifier wrote
-- positive/neutral/negative, and the leadReplies cron wrote interested/objection/
-- wrong_fit/unsubscribe. The consolidated classifier now emits one canonical set
-- (@nous/core replySignals): positive · negative · neutral · objection ·
-- unsubscribe · do_not_contact · bounce · auto_reply.
--
-- This brings historical rows into that one vocabulary so the Signal column is
-- consistent. Only the two non-canonical legacy values need remapping:
--   interested -> positive
--   wrong_fit  -> negative
-- (objection / unsubscribe / positive / negative / neutral are already canonical.)
--
-- Idempotent: after the remap no legacy rows remain, so re-running is a no-op.
-- Safe: touches only the `sentiment` claim value; does not affect observation
-- rawData (so the CRM create-gate, which reads rawData.sentiment, is unaffected).

BEGIN;

UPDATE claims
SET value = to_jsonb('positive'::text)
WHERE property = 'sentiment'
  AND value #>> '{}' = 'interested';

UPDATE claims
SET value = to_jsonb('negative'::text)
WHERE property = 'sentiment'
  AND value #>> '{}' = 'wrong_fit';

COMMIT;
