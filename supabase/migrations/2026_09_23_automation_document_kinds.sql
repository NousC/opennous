-- The three artifacts an automation produces (GET-426).
--
-- account_summary · call_summary · call_score. They are documents, not a new table: a
-- generated summary has a subject, a period, sections, sources and versions, which is every
-- property a document has, and a second home for them would mean two answers to "what has
-- been written about this account".
--
-- Additive and idempotent, like every migration here — the constraint is dropped and rebuilt
-- with the old kinds plus the new, so re-running it is a no-op and nothing already filed
-- becomes invalid.

alter table public.documents drop constraint if exists documents_kind_check;
alter table public.documents add constraint documents_kind_check
  check (kind in (
    'brief', 'plan', 'report', 'meeting_brief', 'objection_prep', 'call',
    'account_summary', 'call_summary', 'call_score'
  ));
